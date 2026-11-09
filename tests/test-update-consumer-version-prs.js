#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STABLE_BRANCH,
  CONSUMER_REPOS,
  validateVersion,
  applyVersionUpdate,
  planVersionUpdate,
  setupGitAuthentication,
  enableAutoMerge,
} = require('../scripts/update-consumer-version-prs');

const VERSION = '2026.4.47';
const CURRENT_PINS = {
  monorepo: '{\n\t"version": "2026.11.12"\n}\n',
  electron: "const TRANSLATION_VERSION = '2026.11.13';",
  'woocommerce-pos': "\\define( __NAMESPACE__ . '\\TRANSLATION_VERSION', '2026.11.14' );",
  'woocommerce-pos-pro': "const TRANSLATION_VERSION = '2026.11.14';\n\\define( 'WCPOS\\WooCommercePOS\\TRANSLATION_VERSION', TRANSLATION_VERSION );",
};

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

test('updates woocommerce-pos-pro when free namespace constant references the pro constant', () => {
  const original = [
    "const TRANSLATION_VERSION = '2026.5.2';",
    "if ( ! \\defined( 'WCPOS\\WooCommercePOS\\TRANSLATION_VERSION' ) ) {",
    "\t\\define( 'WCPOS\\WooCommercePOS\\TRANSLATION_VERSION', TRANSLATION_VERSION );",
    "}",
  ].join('\n');

  const updated = applyVersionUpdate('woocommerce-pos-pro', original, VERSION);
  assert.match(updated, /const TRANSLATION_VERSION = '2026\.4\.47'/);
  assert.match(updated, /TRANSLATION_VERSION', TRANSLATION_VERSION/);
});

test('updates monorepo translation-version.json and keeps its layout', () => {
  const updated = applyVersionUpdate('monorepo', CURRENT_PINS.monorepo, VERSION);
  assert.equal(updated, '{\n\t"version": "2026.4.47"\n}\n');
});

test('monorepo entry points at translation-version.json', () => {
  assert.equal(CONSUMER_REPOS.monorepo.file, 'packages/core/src/contexts/translations/translation-version.json');
});

test('old monorepo TS layout no longer matches the monorepo entry', () => {
  const original = "export const TRANSLATION_VERSION = '2026.2.10';\n";
  assert.throws(() => applyVersionUpdate('monorepo', original, VERSION), /No match found for monorepo/);
});

test('old constant layouts still update for electron, woocommerce-pos and -pro', () => {
  assert.equal(
    applyVersionUpdate('electron', CURRENT_PINS.electron, VERSION),
    "const TRANSLATION_VERSION = '2026.4.47';"
  );
  assert.equal(
    applyVersionUpdate('woocommerce-pos', CURRENT_PINS['woocommerce-pos'], VERSION),
    "\\define( __NAMESPACE__ . '\\TRANSLATION_VERSION', '2026.4.47' );"
  );
  assert.equal(
    applyVersionUpdate('woocommerce-pos-pro', CURRENT_PINS['woocommerce-pos-pro'], VERSION),
    "const TRANSLATION_VERSION = '2026.4.47';\n\\define( 'WCPOS\\WooCommercePOS\\TRANSLATION_VERSION', TRANSLATION_VERSION );"
  );
});

test('dry-run plan reports would-create, would-update and already-current', () => {
  const calls = [];
  const readers = {
    readPinFile: (repo) => CURRENT_PINS[repo.split('/')[1]],
    findOpenPr: (repo, branch) => {
      calls.push([repo, branch]);
      return repo === 'wcpos/electron' ? '12' : '';
    },
  };
  const versions = ['2026.11.12', '2026.11.13', '2026.11.14', '2026.11.14'];
  Object.entries(CONSUMER_REPOS).forEach(([repoKey, config], index) => {
    assert.deepEqual(planVersionUpdate(repoKey, '2026.11.16', readers), {
      repo: config.repo,
      file: config.file,
      from: versions[index],
      status: repoKey === 'electron' ? 'would-update-pr' : 'would-create-pr',
      prNumber: repoKey === 'electron' ? '12' : '',
    });
  });
  assert.deepEqual(calls, Object.values(CONSUMER_REPOS).map((config) => [config.repo, config.branch]));
  calls.length = 0;
  assert.deepEqual(planVersionUpdate('monorepo', '2026.11.12', readers), {
    repo: 'wcpos/monorepo',
    file: CONSUMER_REPOS.monorepo.file,
    from: '2026.11.12',
    status: 'already-current',
    prNumber: '',
  });
  assert.deepEqual(calls, []);
});

test('dry-run plan passes repo, file and base branch to the reader', () => {
  const calls = [];
  planVersionUpdate('monorepo', '2026.11.16', {
    readPinFile: (...args) => {
      calls.push(args);
      return CURRENT_PINS.monorepo;
    },
    findOpenPr: () => '',
  });
  assert.deepEqual(calls, [
    ['wcpos/monorepo', 'packages/core/src/contexts/translations/translation-version.json', 'main'],
  ]);
});

test('dry-run plan throws on a missing pin', () => {
  assert.throws(() => planVersionUpdate('monorepo', '2026.11.16', {
    readPinFile: () => '{}\n',
    findOpenPr: () => assert.fail('must not look up a PR when the pin is missing'),
  }), /No match found for monorepo/);
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

test('arms squash auto-merge on the consumer PR it just created or updated', () => {
  const calls = [];
  const ok = enableAutoMerge('wcpos/woocommerce-pos', 'https://github.com/wcpos/woocommerce-pos/pull/2310', (cmd, args, options) => {
    calls.push([cmd, args, options]);
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ['gh', ['pr', 'merge', '--auto', '--squash', '--repo', 'wcpos/woocommerce-pos', 'https://github.com/wcpos/woocommerce-pos/pull/2310'], { allowFailure: true }],
  ]);
});

test('a failed auto-merge enable is logged, not thrown, so the release still completes', () => {
  const ok = enableAutoMerge('wcpos/electron', '42', () => ({ status: 1, stdout: '', stderr: 'auto-merge is not allowed' }));
  assert.equal(ok, false);
});

test('a gh spawn error or timeout while enabling auto-merge is logged, not thrown', () => {
  const ok = enableAutoMerge('wcpos/monorepo', '7', () => {
    throw new Error('gh pr merge failed: spawnSync gh ETIMEDOUT');
  });
  assert.equal(ok, false);
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
