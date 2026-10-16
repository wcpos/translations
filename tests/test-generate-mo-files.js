#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parsePoFile, compileMo } = require('../scripts/po-file');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

const script = path.resolve(__dirname, '../scripts/generate-mo-files.js');
const root = fs.mkdtempSync(path.join(__dirname, '.generate-mo-'));
const directory = path.join(root, 'translations/php/da');
const poFile = path.join(directory, 'app-da.po');
const moFile = path.join(directory, 'app-da.mo');
const po = 'msgid ""\nmsgstr "Language: da\\n"\n\nmsgid "Paid"\nmsgstr "Betalt"\n';
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

try {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(poFile, po);
  test('--check reports a missing .mo', () => {
    const result = run('--root', root, '--check');
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes('stale: translations/php/da/app-da.mo'));
    assert.ok(!fs.existsSync(moFile));
  });
  test('generate writes the compiled .mo', () => {
    const result = run('--root', root);
    assert.equal(result.status, 0, result.stderr);
    const { entries, header } = parsePoFile(po);
    assert.ok(fs.existsSync(moFile));
    assert.ok(fs.readFileSync(moFile).equals(compileMo(entries, header)));
  });
  test('--check accepts a matching .mo', () => {
    const result = run('--check', '--root', root);
    assert.equal(result.status, 0, result.stderr);
  });
  test('--check reports a changed translation without writing', () => {
    const before = fs.readFileSync(moFile);
    fs.writeFileSync(poFile, po.replace('Betalt', 'Betalt nu'));
    const result = run('--root', root, '--check');
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes('stale: translations/php/da/app-da.mo'));
    assert.ok(fs.readFileSync(moFile).equals(before));
  });
  test('a root with no .po files exits 2', () => {
    const emptyRoot = path.join(root, 'empty');
    fs.mkdirSync(emptyRoot);
    const result = run('--root', emptyRoot);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes('generate-mo: no .po files found'));
  });
  test('unknown arguments exit 2', () => {
    const result = run('--root', root, '--bogus');
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes('Unknown argument: --bogus'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
