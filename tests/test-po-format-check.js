#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '../scripts/check-po-format.sh');
const fixtureDir = path.join(__dirname, 'fixtures/po-format');

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

test('rejects the sv_SE bare-% fixture', () => {
  const result = spawnSync('sh', [scriptPath, path.join(fixtureDir, 'sv_SE-bare-percent.po')], {
    encoding: 'utf8', env: process.env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /sv_SE-bare-percent\.po/);
});

test('accepts the escaped-% fixture', () => {
  const result = spawnSync('sh', [scriptPath, path.join(fixtureDir, 'sv_SE-escaped-percent.po')], {
    encoding: 'utf8', env: process.env,
  });
  assert.equal(result.status, 0);
});

test('fails when msgfmt is missing', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-format-path-'));
  try {
    const result = spawnSync('/bin/sh', [scriptPath, path.join(fixtureDir, 'sv_SE-escaped-percent.po')], {
      encoding: 'utf8', env: { ...process.env, PATH: emptyDir },
    });
    assert.equal(result.status, 2);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('checks the whole tree from another cwd', () => {
  const result = spawnSync('sh', [scriptPath], {
    encoding: 'utf8', env: process.env, cwd: os.tmpdir(),
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /check-po-format: \d+ checked, 0 failed/);
});
