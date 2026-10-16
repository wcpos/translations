#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { parsePoFile, compileMo } = require('./po-file');

function main() {
  let root = path.resolve(__dirname, '..');
  let check = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--root' && args[i + 1] !== undefined) root = path.resolve(args[++i]);
    else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exitCode = 2;
      return;
    }
  }
  const directory = path.join(root, 'translations/php');
  const files = [];
  if (fs.existsSync(directory)) {
    for (const locale of fs.readdirSync(directory).sort()) {
      const localeDirectory = path.join(directory, locale);
      if (!fs.statSync(localeDirectory).isDirectory()) continue;
      for (const name of fs.readdirSync(localeDirectory).sort()) {
        if (name.endsWith('.po')) files.push(path.join(localeDirectory, name));
      }
    }
  }
  if (files.length === 0) {
    console.error('generate-mo: no .po files found');
    process.exitCode = 2;
    return;
  }
  let stale = 0;
  for (const po of files) {
    const { header, entries } = parsePoFile(fs.readFileSync(po, 'utf8'));
    const mo = compileMo(entries, header);
    const target = po.replace(/\.po$/, '.mo');
    if (!check) fs.writeFileSync(target, mo);
    else if (!fs.existsSync(target) || Buffer.compare(fs.readFileSync(target), mo) !== 0) {
      stale++;
      const relative = path.relative(root, target);
      console.log(`stale: ${relative}`);
      if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::error file=${relative}::stale .mo; run pnpm run generate:mo`);
      }
    }
  }
  if (stale) {
    console.error(`generate-mo: ${stale} of ${files.length} .mo files are stale (run pnpm run generate:mo)`);
    process.exitCode = 1;
  } else {
    console.log(check
      ? `generate-mo: ${files.length} .mo files match their .po`
      : `generate-mo: wrote ${files.length} .mo files`);
  }
}

main();
