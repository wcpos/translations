#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

// The shared CDN bucket is fixed across both translation release lanes.
const OBJECTS_URL = 'https://api.cloudflare.com/client/v4/accounts/d9df0d95f1cee465811e977842e5063a/r2/buckets/wcpos-web-bundles/objects/';
// Eight simultaneous uploads keep the mirror bounded without serializing every file.
const CONCURRENCY = 8;
// One retry covers transient transport/server errors without hiding persistent failures.
const RETRIES = 1;

function contentType(file) {
  switch (path.extname(file)) {
    case '.json': return 'application/json';
    case '.php': return 'application/x-httpd-php';
    case '.po':
    case '.pot': return 'text/plain; charset=utf-8';
    case '.mo':
    default: return 'application/octet-stream';
  }
}

async function uploadTree({ root, ref, token, fetch = globalThis.fetch }) {
  if (!ref || !token) throw new Error('cdn-upload: ref and CLOUDFLARE_CDN_TOKEN are required');

  async function request(key, method, body) {
    const url = OBJECTS_URL + key.split('/').map(encodeURIComponent).join('/');
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method,
          redirect: 'manual',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType(key) },
          body,
        });
      } catch {
        if (attempt < RETRIES) continue;
        throw new Error(`cdn-upload: ${method} failed after ${attempt + 1} network attempts`);
      }
      // Release response resources before the next upload or retry.
      await response.body?.cancel();
      if (response.ok || (method === 'HEAD' && response.status === 404)) return response.status;
      if (response.status >= 500 && response.status <= 599 && attempt < RETRIES) continue;
      throw new Error(`cdn-upload: ${method} failed (HTTP ${response.status})`);
    }
  }

  const prefix = `translations/${ref}`;
  const marker = `${prefix}/.complete`;
  if (ref !== 'next' && await request(marker, 'HEAD') !== 404) {
    console.log('cdn-upload: uploaded 0 files; skipped 1 completed release');
    return;
  }

  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  walk('translations');

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const results = await Promise.allSettled(files.slice(i, i + CONCURRENCY).map(async file => {
      const body = await fs.promises.readFile(path.join(root, file));
      await request(`${prefix}/${file}`, 'PUT', body);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  if (ref !== 'next') await request(marker, 'PUT', Buffer.alloc(0));
  console.log(`cdn-upload: uploaded ${files.length} files; wrote ${ref === 'next' ? 0 : 1} completion markers`);
}

module.exports = { uploadTree, contentType };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--ref' || !args[1]) {
    console.error('Usage: node scripts/cdn-upload.js --ref <tag|next>');
    process.exitCode = 1;
  } else {
    uploadTree({
      root: path.resolve(__dirname, '..'),
      ref: args[1],
      token: process.env.CLOUDFLARE_CDN_TOKEN,
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
