#!/usr/bin/env node

const assert = require('node:assert/strict');

const {
  STABLE_BRANCH,
  CONSUMER_REPOS,
  validateVersion,
  applyVersionUpdate,
} = require('../scripts/update-consumer-version-prs');

const VERSION = '2026.4.47';

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

console.log('Testing consumer translation PR updater');

test('accepts valid CalVer versions', () => {
  assert.equal(validateVersion(VERSION), VERSION);
});

test('rejects invalid versions', () => {
  assert.throws(() => validateVersion('2026-4-47'), /Invalid version format/);
  assert.throws(() => validateVersion('foo'), /Invalid version format/);
});

test('all consumer repos use the stable update branch', () => {
  const repos = Object.values(CONSUMER_REPOS);
  assert.ok(repos.length >= 4);
  for (const repo of repos) {
    assert.equal(repo.branch, STABLE_BRANCH);
  }
});

test('updates woocommerce-pos version constant', () => {
  const original = "\t\\define( __NAMESPACE__ . '\\TRANSLATION_VERSION', '2026.2.10' );\n";
  const updated = applyVersionUpdate('woocommerce-pos', original, VERSION);
  assert.match(updated, /TRANSLATION_VERSION', '2026\.4\.47'/);
});

test('updates woocommerce-pos-pro version constants', () => {
  const original = "const TRANSLATION_VERSION = '2026.2.10';\n\\define( 'WCPOS\\WooCommercePOS\\TRANSLATION_VERSION', '2026.2.10' );\n";
  const updated = applyVersionUpdate('woocommerce-pos-pro', original, VERSION);
  assert.match(updated, /const TRANSLATION_VERSION = '2026\.4\.47'/);
  assert.match(updated, /TRANSLATION_VERSION', '2026\.4\.47'/);
});

test('updates monorepo translation backend version', () => {
  const original = "export const TRANSLATION_VERSION = '2026.2.10';\n";
  const updated = applyVersionUpdate('monorepo', original, VERSION);
  assert.match(updated, /TRANSLATION_VERSION = '2026\.4\.47'/);
});

test('updates electron translation backend version', () => {
  const original = "export const TRANSLATION_VERSION = '2026.2.10';\n";
  const updated = applyVersionUpdate('electron', original, VERSION);
  assert.match(updated, /TRANSLATION_VERSION = '2026\.4\.47'/);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
