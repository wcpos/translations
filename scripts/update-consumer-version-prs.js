#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STABLE_BRANCH = 'chore/update-translation-version';

const CONSUMER_REPOS = {
  monorepo: {
    repo: 'wcpos/monorepo',
    branch: STABLE_BRANCH,
    baseBranch: 'main',
    file: 'packages/core/src/contexts/translations/rxdb-backend.ts',
    replacements: [
      {
        pattern: /TRANSLATION_VERSION = '[^']+'/g,
        replace: (_, nextVersion) => `TRANSLATION_VERSION = '${nextVersion}'`,
      },
    ],
  },
  electron: {
    repo: 'wcpos/electron',
    branch: STABLE_BRANCH,
    baseBranch: 'main',
    file: 'src/main/translations/index.ts',
    replacements: [
      {
        pattern: /TRANSLATION_VERSION = '[^']+'/g,
        replace: (_, nextVersion) => `TRANSLATION_VERSION = '${nextVersion}'`,
      },
    ],
  },
  'woocommerce-pos': {
    repo: 'wcpos/woocommerce-pos',
    branch: STABLE_BRANCH,
    baseBranch: 'main',
    file: 'woocommerce-pos.php',
    replacements: [
      {
        pattern: /TRANSLATION_VERSION', '[^']+'/g,
        replace: (_, nextVersion) => `TRANSLATION_VERSION', '${nextVersion}'`,
      },
    ],
  },
  'woocommerce-pos-pro': {
    repo: 'wcpos/woocommerce-pos-pro',
    branch: STABLE_BRANCH,
    baseBranch: 'main',
    file: 'woocommerce-pos-pro.php',
    replacements: [
      {
        pattern: /TRANSLATION_VERSION = '[^']+'/g,
        replace: (_, nextVersion) => `TRANSLATION_VERSION = '${nextVersion}'`,
      },
      {
        pattern: /TRANSLATION_VERSION', '[^']+'/g,
        replace: (_, nextVersion) => `TRANSLATION_VERSION', '${nextVersion}'`,
        required: false,
      },
    ],
  },
};

function run(cmd, args = [], options = {}) {
  const { allowFailure, ...spawnOptions } = options;
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    killSignal: 'SIGTERM',
    ...spawnOptions,
  });

  if (result.error) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.error.message}`);
  }

  if (allowFailure) {
    return result;
  }

  if (result.status !== 0) {
    const stderr = result.stderr || result.stdout || '';
    throw new Error(`${cmd} ${args.join(' ')} failed with code ${result.status}: ${stderr.trim()}`);
  }

  return result;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function validateVersion(version) {
  if (!/^\d{4}\.\d+\.\d+$/.test(version || '')) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return version;
}

function applyReplacements(content, replacements, version, repoKey) {
  let updated = content;

  for (const replacement of replacements) {
    const matches = [...updated.matchAll(replacement.pattern)];
    if (matches.length === 0) {
      if (replacement.required === false) {
        continue;
      }
      throw new Error(`No match found for ${repoKey} using pattern ${replacement.pattern}`);
    }

    updated = updated.replace(replacement.pattern, (match) =>
      replacement.replace(match, version)
    );
  }

  return updated;
}

function applyVersionUpdate(repoKey, content, version) {
  const config = CONSUMER_REPOS[repoKey];
  if (!config) {
    throw new Error(`Unknown consumer repo: ${repoKey}`);
  }

  return applyReplacements(content, config.replacements, validateVersion(version), repoKey);
}

function repoPath(tempRoot, repoKey) {
  return path.join(tempRoot, repoKey);
}

function remoteBranchExists(cwd, branch) {
  const result = run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
    cwd,
    allowFailure: true,
  });
  return result.status === 0;
}

function getHeadRef(branch) {
  return branch;
}

function setupGitAuthentication(runCommand = run) {
  runCommand('gh', ['auth', 'setup-git', '--hostname', 'github.com']);
}

function getOpenPrNumber(repo, branch) {
  const result = run('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--head',
    getHeadRef(branch),
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ]);

  return (result.stdout || '').trim();
}

function buildPrTitle(version) {
  return `chore: update translation version to ${version}`;
}

function buildPrBody(version) {
  return [
    `Automated PR to update translation version to ${version}.`,
    '',
    'This branch is reused by the translations release workflow.',
  ].join('\n');
}

// The consumer repos' Merge Gate passes this PR by shape (translations-ci author, exact
// title, only the version line changed) and their review gate exempts the same shape from
// Codex (wcpos/.github#19, 2026-10-19), so nothing is left for a person to do: arm squash
// auto-merge and GitHub merges it once the required checks report. Enabling is best-effort —
// a repo without auto-merge, or a PR that is already armed, must not fail the release; the
// PR still exists and a person can merge it as before.
function enableAutoMerge(repo, prRef, runCommand = run) {
  let result;
  try {
    result = runCommand('gh', ['pr', 'merge', '--auto', '--squash', '--repo', repo, prRef], {
      allowFailure: true,
    });
  } catch (error) {
    // `run` throws on a spawn error or its 120 s timeout before `allowFailure` applies.
    log(`Could not enable auto-merge on ${repo} ${prRef}: ${error.message}`);
    return false;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || '').trim();
    log(`Could not enable auto-merge on ${repo} ${prRef}: ${stderr}`);
    return false;
  }
  log(`Auto-merge enabled on ${repo} ${prRef}`);
  return true;
}

async function prepareRepoCheckout(tempRoot, repoKey, config) {
  const checkoutPath = repoPath(tempRoot, repoKey);
  run('gh', ['repo', 'clone', config.repo, checkoutPath]);

  const cwd = checkoutPath;
  run('git', ['config', 'user.name', 'github-actions[bot]'], { cwd });
  run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd });
  run('git', ['fetch', 'origin', config.baseBranch], { cwd });
  run('git', ['fetch', 'origin', config.branch], { cwd, allowFailure: true });

  if (remoteBranchExists(cwd, config.branch)) {
    run('git', ['checkout', '-B', config.branch, `origin/${config.branch}`], { cwd });
    run('git', ['reset', '--hard', `origin/${config.baseBranch}`], { cwd });
  } else {
    run('git', ['checkout', '-B', config.branch, `origin/${config.baseBranch}`], { cwd });
  }

  return cwd;
}

async function updateRepo(repoKey, version, tempRoot) {
  const config = CONSUMER_REPOS[repoKey];
  if (!config) {
    throw new Error(`Unknown consumer repo: ${repoKey}`);
  }

  log(`\n==> ${config.repo}`);
  const cwd = await prepareRepoCheckout(tempRoot, repoKey, config);
  const filePath = path.join(cwd, config.file);
  const original = await fsp.readFile(filePath, 'utf8');
  const updated = applyVersionUpdate(repoKey, original, version);

  if (updated === original) {
    log(`Already at ${version}; skipping.`);
    return { repo: config.repo, status: 'skipped' };
  }

  await fsp.writeFile(filePath, updated);
  run('git', ['add', config.file], { cwd });

  const stagedDiff = run('git', ['diff', '--cached', '--quiet'], { cwd, allowFailure: true });
  if (stagedDiff.status === 0) {
    log('No staged diff after update; skipping.');
    return { repo: config.repo, status: 'skipped' };
  }

  const commitMessage = buildPrTitle(version);
  run('git', ['commit', '-m', commitMessage], { cwd });
  run('git', ['push', '--force-with-lease', '-u', 'origin', config.branch], { cwd });

  const prNumber = getOpenPrNumber(config.repo, config.branch);
  const prTitle = buildPrTitle(version);
  const prBody = buildPrBody(version);

  if (prNumber) {
    run('gh', ['pr', 'edit', prNumber, '--repo', config.repo, '--title', prTitle, '--body', prBody], { cwd });
    log(`Updated existing PR #${prNumber}`);
    enableAutoMerge(config.repo, prNumber);
    return { repo: config.repo, status: 'updated-pr', prNumber };
  }

  const created = run('gh', [
    'pr',
    'create',
    '--repo',
    config.repo,
    '--base',
    config.baseBranch,
    '--head',
    getHeadRef(config.branch),
    '--title',
    prTitle,
    '--body',
    prBody,
  ], { cwd });

  const prUrl = created.stdout.trim();
  log(`Created PR ${prUrl}`);
  enableAutoMerge(config.repo, prUrl);
  return { repo: config.repo, status: 'created-pr', prUrl };
}

async function main() {
  const version = validateVersion(process.argv[2]);
  const requestedRepos = process.argv.slice(3);
  const repoKeys = requestedRepos.length > 0 ? requestedRepos : Object.keys(CONSUMER_REPOS);

  for (const repoKey of repoKeys) {
    if (!CONSUMER_REPOS[repoKey]) {
      throw new Error(`Unknown consumer repo: ${repoKey}`);
    }
  }

  if (!process.env.GH_TOKEN) {
    throw new Error('GH_TOKEN is required');
  }

  setupGitAuthentication();

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'translation-consumers-'));
  try {
    for (const repoKey of repoKeys) {
      await updateRepo(repoKey, version, tempRoot);
    }
  } finally {
    if (fs.existsSync(tempRoot)) {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

module.exports = {
  STABLE_BRANCH,
  CONSUMER_REPOS,
  validateVersion,
  applyVersionUpdate,
  buildPrTitle,
  buildPrBody,
  setupGitAuthentication,
  enableAutoMerge,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
