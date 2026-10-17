#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uploadTree, contentType } = require('../scripts/cdn-upload');

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.stack}`);
    process.exitCode = 1;
  }
}

const types = {
  'core.json': 'application/json',
  'app.l10n.php': 'application/x-httpd-php',
  'app.po': 'text/plain; charset=utf-8',
  'app.mo': 'application/octet-stream',
  'app.pot': 'text/plain; charset=utf-8',
  'unknown.bin': 'application/octet-stream',
};

function recorder(respond = () => 200) {
  const calls = [];
  const fetch = async (url, options) => {
    const call = { url, ...options };
    calls.push(call);
    const status = await respond(call);
    return new Response(null, { status });
  };
  return { calls, fetch };
}

async function main() {
  await test('content types cover translations and unknown extensions', () => {
    for (const [name, type] of Object.entries(types)) assert.equal(contentType(name), type);
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-upload-'));
  const folder = path.join(root, 'translations/js/é space');
  const token = 'test-token';
  const ref = '2026.10.0';
  const base = 'https://api.cloudflare.com/client/v4/accounts/d9df0d95f1cee465811e977842e5063a/r2/buckets/wcpos-web-bundles/objects/';
  const marker = `${base}translations/${ref}/.complete`;
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(root, 'do-not-upload.txt'), 'outside translations');
    for (const name of Object.keys(types)) fs.writeFileSync(path.join(folder, name), `bytes: ${name}`);
    fs.writeFileSync(path.join(folder, 'hash#?.json'), 'encoded filename');
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(folder, `extra-${i}.json`), '{}');

    await test('uploads only the translation tree with encoded keys, bytes, types and marker last', async () => {
      let active = 0;
      let peak = 0;
      let completed = 0;
      let releaseBatch;
      const firstBatch = new Promise(resolve => { releaseBatch = resolve; });
      const timer = setTimeout(releaseBatch, 1000);
      const fake = recorder(async call => {
        if (call.method === 'HEAD') return 404;
        if (call.url === marker) {
          assert.equal(completed, 11);
          assert.equal(active, 0);
        } else {
          active++;
          peak = Math.max(peak, active);
          if (active === 8) {
            clearTimeout(timer);
            releaseBatch();
          }
          await firstBatch;
          await new Promise(resolve => setImmediate(resolve));
          active--;
          completed++;
        }
        return 200;
      });
      await uploadTree({ root, ref, token, fetch: fake.fetch });
      assert.equal(fake.calls.length, 13);
      assert.equal(fake.calls[0].url, marker);
      assert.equal(fake.calls[0].method, 'HEAD');
      assert.equal(fake.calls.at(-1).url, marker);
      assert.equal(fake.calls.at(-1).method, 'PUT');
      assert.equal(peak, 8);
      for (const call of fake.calls) assert.equal(call.headers.Authorization, `Bearer ${token}`);
      const uploads = fake.calls.slice(1, -1);
      for (const [name, type] of Object.entries(types)) {
        const call = uploads.find(item => item.url === `${base}translations/${ref}/translations/js/%C3%A9%20space/${name}`);
        assert.ok(call, name);
        assert.equal(call.method, 'PUT');
        assert.equal(call.headers['Content-Type'], type);
        assert.equal(call.body.toString(), `bytes: ${name}`);
      }
      assert.ok(uploads.some(call => call.url.endsWith('/hash%23%3F.json')));
      assert.ok(uploads.every(call => call.url.startsWith(`${base}translations/${ref}/translations/`)));
    });

    await test('an existing completion marker skips all uploads', async () => {
      const fake = recorder();
      await uploadTree({ root, ref, token, fetch: fake.fetch });
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].method, 'HEAD');
      assert.equal(fake.calls[0].url, marker);
    });

    await test('next overwrites every time without checking or writing a marker', async () => {
      const fake = recorder();
      await uploadTree({ root, ref: 'next', token, fetch: fake.fetch });
      fs.writeFileSync(path.join(folder, 'core.json'), 'updated');
      await uploadTree({ root, ref: 'next', token, fetch: fake.fetch });
      assert.equal(fake.calls.length, 22);
      assert.ok(fake.calls.every(call => call.method === 'PUT' && call.url.startsWith(`${base}translations/next/translations/`)));
      const versions = fake.calls.filter(call => call.url.endsWith('/core.json'));
      assert.deepEqual(versions.map(call => call.body.toString()), ['bytes: core.json', 'updated']);
    });

    for (const failure of ['503', 'network']) {
      await test(`retries a ${failure} failure once and then completes`, async () => {
        const attempts = new Map();
        const fake = recorder(call => {
          if (call.method === 'HEAD') return 404;
          const count = (attempts.get(call.url) || 0) + 1;
          attempts.set(call.url, count);
          if (count === 1) {
            if (failure === 'network') throw new Error('connection lost');
            return 503;
          }
          return 200;
        });
        await uploadTree({ root, ref, token, fetch: fake.fetch });
        assert.equal(attempts.size, 12);
        assert.ok([...attempts.values()].every(count => count === 2));
        assert.equal(fake.calls.at(-1).url, marker);
      });
    }

    for (const status of [403, 503]) {
      await test(`persistent ${status} fails without a completion marker`, async () => {
        const fake = recorder(call => call.method === 'HEAD' ? 404 : status);
        await assert.rejects(uploadTree({ root, ref, token, fetch: fake.fetch }), new RegExp(String(status)));
        const puts = fake.calls.filter(call => call.method === 'PUT');
        assert.ok(puts.length > 0);
        assert.ok(puts.every(call => call.url !== marker));
        for (const url of new Set(puts.map(call => call.url))) {
          assert.equal(puts.filter(call => call.url === url).length, status === 503 ? 2 : 1);
        }
      });
    }

    await test('a forbidden marker check fails rather than overwriting the release', async () => {
      const fake = recorder(() => 403);
      await assert.rejects(uploadTree({ root, ref, token, fetch: fake.fetch }), /403/);
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].method, 'HEAD');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
