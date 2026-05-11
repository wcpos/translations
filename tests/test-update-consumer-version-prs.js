#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STABLE_BRANCH,
  CONSUMER_REPOS,
  validateVersion,
  applyVersionUpdate,
  setupGitAuthentication,
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
  assert.throws(() => validateVersion(''), /Invalid version format/);
  assert.throws(() => validateVersion(null), /Invalid version format/);
  assert.throws(() => validateVersion(undefined), /Invalid version format/);
  assert.throws(() => validateVersion('2026.4'), /Invalid version format/);
  assert.throws(() => validateVersion('2026.4.47.0'), /Invalid version format/);
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

test('configures gh as git credential helper for GitHub pushes', () => {
  const calls = [];
  setupGitAuthentication((cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0 };
  });

  assert.deepEqual(calls, [
    ['gh', ['auth', 'setup-git', '--hostname', 'github.com']],
  ]);
});

function getWorkflowStep(workflow, stepName) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return workflow.match(new RegExp(`-\\s*name:\\s*${escapedName}[\\s\\S]*?(?=\\n\\s{6}-\\s*name:|$)`))?.[0] || '';
}

test('release workflow requests exact app token access needed for consumer PRs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const tokenSteps = [
    getWorkflowStep(workflow, 'Generate consumer GitHub App token (preflight)'),
    getWorkflowStep(workflow, 'Generate consumer GitHub App token'),
  ];

  for (const tokenStep of tokenSteps) {
    assert.match(tokenStep, /repositories:\s*monorepo,electron,woocommerce-pos,woocommerce-pos-pro/);
    assert.match(tokenStep, /permission-contents:\s*write/);
    assert.match(tokenStep, /permission-pull-requests:\s*write/);
  }
});

test('release workflow validates consumer app token before creating an irreversible release', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

  const preflightTokenStepIndex = workflow.indexOf('- name: Generate consumer GitHub App token (preflight)');
  const verifyStepIndex = workflow.indexOf('- name: Verify consumer GitHub App access');
  const releaseStepIndex = workflow.indexOf('- name: Create tag and release');

  assert.notEqual(preflightTokenStepIndex, -1, 'preflight GitHub App token step must exist');
  assert.notEqual(verifyStepIndex, -1, 'Verify consumer GitHub App access step must exist');
  assert.notEqual(releaseStepIndex, -1, 'Create tag and release step must exist');
  assert.ok(
    preflightTokenStepIndex < verifyStepIndex && verifyStepIndex < releaseStepIndex,
    'consumer GitHub App token must be minted and verified before tag/release creation so permission failures do not leave partial releases'
  );
});

test('release workflow mints a fresh consumer app token after uploading assets', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

  const releaseStepIndex = workflow.indexOf('- name: Create tag and release');
  const freshTokenStepIndex = workflow.indexOf('- name: Generate consumer GitHub App token', releaseStepIndex);
  const updateStepIndex = workflow.indexOf('- name: Update consuming repos');

  assert.notEqual(releaseStepIndex, -1, 'Create tag and release step must exist');
  assert.notEqual(freshTokenStepIndex, -1, 'fresh post-release GitHub App token step must exist');
  assert.notEqual(updateStepIndex, -1, 'Update consuming repos step must exist');
  assert.ok(
    releaseStepIndex < freshTokenStepIndex && freshTokenStepIndex < updateStepIndex,
    'consumer updater must use a freshly minted token after the potentially long release upload step'
  );
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
