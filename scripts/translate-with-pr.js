#!/usr/bin/env node

/**
 * Translate a locale and create a PR with full QA results.
 *
 * This script:
 * 1. Creates a new branch for the translation
 * 2. Runs the translation with verification
 * 3. Runs QA checks
 * 4. Commits changes
 * 5. Creates a PR with detailed results
 *
 * Usage:
 *   node scripts/translate-with-pr.js <locale> [--type js|php|all] [--force]
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const LOCALE_NAMES = require('../locales.json');

function run(cmd, args = [], options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...options,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function runAsync(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      encoding: 'utf8',
      ...options,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data;
      process.stdout.write(data);
    });

    proc.stderr?.on('data', (data) => {
      stderr += data;
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, status: code });
    });

    proc.on('error', reject);
  });
}

async function main() {
  const locale = process.argv[2];
  if (!locale) {
    console.error('Usage: node scripts/translate-with-pr.js <locale> [--type js|php|all] [--force]');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY required');
    process.exit(1);
  }

  const typeIdx = process.argv.indexOf('--type');
  const type = typeIdx !== -1 ? process.argv[typeIdx + 1] : 'all';
  const force = process.argv.includes('--force');

  const localeName = LOCALE_NAMES[locale] || locale;
  const branchName = `translate/${locale}-${new Date().toISOString().split('T')[0]}`;
  const timestamp = new Date().toISOString();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Translation PR Workflow`);
  console.log(`Locale: ${locale} (${localeName})`);
  console.log(`Type: ${type}`);
  console.log(`Force: ${force}`);
  console.log(`Branch: ${branchName}`);
  console.log(`${'='.repeat(60)}\n`);

  // Check for clean working directory
  const statusResult = run('git', ['status', '--porcelain']);
  if (statusResult.stdout.trim()) {
    console.error('Error: Working directory is not clean. Please commit or stash changes first.');
    process.exit(1);
  }

  // Fetch latest and create branch
  console.log('Step 1: Creating branch...');
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['checkout', 'main']);
  run('git', ['pull', 'origin', 'main']);

  const branchResult = run('git', ['checkout', '-b', branchName]);
  if (branchResult.status !== 0) {
    console.error(`Failed to create branch: ${branchResult.stderr}`);
    process.exit(1);
  }
  console.log(`  Created branch: ${branchName}\n`);

  // Run translation
  console.log('Step 2: Running translation...');
  const translateArgs = ['scripts/translate-locale.js', locale, '--type', type];
  if (force) translateArgs.push('--force');

  const translateResult = await runAsync('node', translateArgs, {
    env: { ...process.env },
    cwd: path.resolve(__dirname, '..'),
  });

  if (translateResult.status !== 0) {
    console.error('\nTranslation failed!');
    run('git', ['checkout', 'main']);
    run('git', ['branch', '-D', branchName]);
    process.exit(1);
  }

  // Capture translation output for PR
  const translationOutput = translateResult.stdout + translateResult.stderr;

  // Check if there are changes
  const diffResult = run('git', ['diff', '--name-only']);
  if (!diffResult.stdout.trim()) {
    console.log('\nNo translation changes to commit.');
    run('git', ['checkout', 'main']);
    run('git', ['branch', '-D', branchName]);
    process.exit(0);
  }

  const changedFiles = diffResult.stdout.trim().split('\n');
  console.log(`\n  Changed files: ${changedFiles.length}`);

  // Run QA
  console.log('\nStep 3: Running QA checks...');
  const qaArgs = ['scripts/qa-translations.js', locale, '--type', type, '--structural-only'];

  const qaResult = await runAsync('node', qaArgs, {
    env: { ...process.env },
    cwd: path.resolve(__dirname, '..'),
  });

  const qaOutput = qaResult.stdout + qaResult.stderr;
  const qaIssues = qaOutput.includes('Total issues:')
    ? qaOutput.match(/Total issues: (\d+)/)?.[1] || '0'
    : '0';

  // Count strings translated
  let stringsTranslated = 0;
  const translateMatch = translationOutput.match(/Translating (\d+)/g);
  if (translateMatch) {
    stringsTranslated = translateMatch.reduce((sum, m) => {
      const num = parseInt(m.match(/\d+/)[0], 10);
      return sum + num;
    }, 0);
  }

  // Commit changes
  console.log('\nStep 4: Committing changes...');
  run('git', ['add', 'translations/', '.translation-state.json']);

  const commitMessage = `chore(i18n): update ${locale} (${localeName}) translations

- Translated ${stringsTranslated} strings
- QA structural issues: ${qaIssues}
- Type: ${type}${force ? ' (forced)' : ''}`;

  run('git', ['commit', '-m', commitMessage]);
  console.log(`  Committed changes\n`);

  // Push branch
  console.log('Step 5: Pushing branch...');
  const pushResult = run('git', ['push', '-u', 'origin', branchName]);
  if (pushResult.status !== 0) {
    console.error(`Failed to push: ${pushResult.stderr}`);
    process.exit(1);
  }
  console.log(`  Pushed to origin/${branchName}\n`);

  // Create PR
  console.log('Step 6: Creating PR...');

  // Build PR body
  const prBody = `## Translation Update: ${locale} (${localeName})

**Date:** ${timestamp}
**Type:** ${type}
**Forced:** ${force ? 'Yes' : 'No'}

### Summary
- **Strings translated:** ${stringsTranslated}
- **Files changed:** ${changedFiles.length}
- **QA issues:** ${qaIssues}

### Changed Files
${changedFiles.map(f => `- \`${f}\``).join('\n')}

### Translation Log
<details>
<summary>Click to expand translation output</summary>

\`\`\`
${translationOutput.substring(0, 5000)}${translationOutput.length > 5000 ? '\n... (truncated)' : ''}
\`\`\`

</details>

### QA Results
<details>
<summary>Click to expand QA output</summary>

\`\`\`
${qaOutput.substring(0, 5000)}${qaOutput.length > 5000 ? '\n... (truncated)' : ''}
\`\`\`

</details>

---
🤖 Generated with [Claude Code](https://claude.ai/code)
`;

  const prTitle = `chore(i18n): update ${locale} (${localeName}) translations`;

  // Write PR body to temp file to handle special characters
  const prBodyFile = '/tmp/pr-body.md';
  await fs.writeFile(prBodyFile, prBody);

  const prResult = run('gh', ['pr', 'create', '--title', prTitle, '--body-file', prBodyFile]);

  if (prResult.status !== 0) {
    console.error(`Failed to create PR: ${prResult.stderr}`);
    console.log('\nYou can create the PR manually with:');
    console.log(`  gh pr create --title "${prTitle}"`);
    process.exit(1);
  }

  const prUrl = prResult.stdout.trim();
  console.log(`  Created PR: ${prUrl}\n`);

  // Switch back to main
  run('git', ['checkout', 'main']);

  console.log('='.repeat(60));
  console.log('Done!');
  console.log(`PR: ${prUrl}`);
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
