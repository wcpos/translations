#!/usr/bin/env node

/**
 * End-to-end workflow test.
 *
 * Tests extraction and validation:
 * 1. Extract strings from fixtures
 * 2. Validate committed translations
 *
 * Usage:
 *   node tests/test-workflow.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_LOCALE = 'de_DE';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SCRIPTS_DIR = path.resolve(__dirname, '../scripts');
const SOURCE_JS_DIR = path.resolve(__dirname, '../source/js');

let passed = 0;
let failed = 0;

function log(msg) {
  console.log(msg);
}

function step(name) {
  log(`\n▸ ${name}`);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

function runScript(script, args = [], env = {}) {
  const result = spawnSync('node', [path.join(SCRIPTS_DIR, script), ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    output: (result.stdout || '') + (result.stderr || ''),
  };
}

// Backup and restore helpers
let backups = {};

function backup(filePath) {
  if (fs.existsSync(filePath)) {
    backups[filePath] = fs.readFileSync(filePath, 'utf8');
  }
}

function restore() {
  for (const [filePath, content] of Object.entries(backups)) {
    fs.writeFileSync(filePath, content);
  }
}

function cleanup() {
  // Remove test-created files
  const testFiles = [
    path.join(SOURCE_JS_DIR, 'core.json'),
    path.join(SOURCE_JS_DIR, 'electron.json'),
    path.join(SOURCE_JS_DIR, 'pro.json'),
    path.join(SOURCE_JS_DIR, 'legacy.json'),
  ];

  for (const file of testFiles) {
    if (fs.existsSync(file) && !backups[file]) {
      fs.unlinkSync(file);
    }
  }

  restore();
}

async function main() {
  log('='.repeat(50));
  log('End-to-End Translation Workflow Test');
  log('='.repeat(50));

  // Backup existing files that might be overwritten
  const existingCoreJson = path.join(SOURCE_JS_DIR, 'core.json');
  const existingElectronJson = path.join(SOURCE_JS_DIR, 'electron.json');
  backup(existingCoreJson);
  backup(existingElectronJson);

  try {
    step('Checking workflows no longer call OpenClaw');

    test('forward-to-aide.yml does not exist', () => {
      if (fs.existsSync(path.resolve(__dirname, '../.github/workflows/forward-to-aide.yml'))) {
        throw new Error('forward-to-aide.yml should be removed');
      }
    });

    for (const name of ['receive-js-strings.yml', 'receive-php-strings.yml', 'check-completeness.yml']) {
      const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8');
      test(`${name} has no OpenClaw forwarding or API keys`, () => {
        if (/forward-to-aide|openclaw|OPENAI_API_KEY|ANTHROPIC_API_KEY/i.test(workflow)) {
          throw new Error(`${name} should not reference OpenClaw forwarding or API keys`);
        }
      });
      if (name.startsWith('receive-')) {
        test(`${name} still commits and pushes source strings`, () => {
          const commits = workflow.match(/      - name: Commit[^\n]*\n(?:(?!      - name:)[\s\S])*/g) || [];
          const expected = name === 'receive-php-strings.yml' ? 2 : 1;
          if (commits.length !== expected || commits.some(commit => !commit.includes('git commit ') || !commit.includes('git push'))) {
            throw new Error(`${name} should keep its git commit and git push steps`);
          }
        });
      }
    }

    // Step 1: Extract strings
    step('Running extraction on test fixtures');

    const extractResult = runScript('extract-js-strings.js', [FIXTURES_DIR]);
    log(extractResult.output);

    test('extraction completes without fatal errors', () => {
      if (extractResult.status !== 0 && !extractResult.output.includes('Warning')) {
        throw new Error(`Extraction failed with status ${extractResult.status}`);
      }
    });

    test('core.json is created', () => {
      const coreJson = path.join(SOURCE_JS_DIR, 'core.json');
      if (!fs.existsSync(coreJson)) {
        throw new Error('core.json not created');
      }
    });

    test('electron.json is created', () => {
      const electronJson = path.join(SOURCE_JS_DIR, 'electron.json');
      if (!fs.existsSync(electronJson)) {
        throw new Error('electron.json not created');
      }
    });

    test('extracted JSON is valid', () => {
      const coreJson = path.join(SOURCE_JS_DIR, 'core.json');
      const content = fs.readFileSync(coreJson, 'utf8');
      JSON.parse(content); // Will throw if invalid
    });

    test('extracted strings include expected values', () => {
      const coreJson = path.join(SOURCE_JS_DIR, 'core.json');
      const content = JSON.parse(fs.readFileSync(coreJson, 'utf8'));
      const keys = Object.keys(content);

      if (!keys.includes('Welcome to WCPOS')) {
        throw new Error('Missing expected string "Welcome to WCPOS"');
      }
    });

    // Step 2: Validate structure
    step('Validating output structure');

    test(
      'validate script runs on translations',
      () => {
        const validateResult = runScript('validate-translations.js', [TEST_LOCALE]);
        log(validateResult.output);

        if (validateResult.status !== 0) {
          throw new Error(`Validation failed: ${validateResult.output}`);
        }
      }
    );
  } finally {
    // Cleanup
    step('Cleaning up');
    cleanup();
    log('  Restored original files');
  }

  // Summary
  log('\n' + '='.repeat(50));
  log(`Results: ${passed} passed, ${failed} failed`);
  log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Test runner error:', error);
  cleanup();
  process.exit(1);
});
