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
    step('Checking Aide forwarding workflow structure');

    const forwardWorkflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/forward-to-aide.yml'), 'utf8');

    test('forward workflow generates translation context artifacts', () => {
      if (!forwardWorkflow.includes('scripts/translation-context-packets.js')) {
        throw new Error('forward-to-aide.yml should invoke scripts/translation-context-packets.js');
      }
    });

    test('forward workflow includes context artifacts and type in payload', () => {
      if (!forwardWorkflow.includes('context_artifacts')) {
        throw new Error('payload should include context_artifacts');
      }
      if (!forwardWorkflow.includes('--arg type')) {
        throw new Error('payload should include type');
      }
    });

    test('forward workflow fails when Aide completes without committing translations', () => {
      if (!forwardWorkflow.includes('OPENCLAW_REQUIRE_TRANSLATION_COMMIT')) {
        throw new Error('forward workflow should require Aide to commit translation changes');
      }
    });

    test('forward workflow commits context artifacts before sending payload', () => {
      if (!forwardWorkflow.includes('contents: write')) {
        throw new Error('forward workflow needs contents: write to persist generated context artifacts');
      }
      if (!forwardWorkflow.includes('git add translation-context/php')) {
        throw new Error('generated context artifacts should be staged');
      }
      if (!forwardWorkflow.includes('chore: update PHP translation context artifacts')) {
        throw new Error('generated context artifacts should be committed before forwarding');
      }
      if (!forwardWorkflow.includes('source_ref')) {
        throw new Error('payload should include source_ref/head_sha for the committed artifact revision');
      }
    });

    test('forward workflow generates PHP context artifacts per locale', () => {
      if (!forwardWorkflow.includes('find translations/php -mindepth 1 -maxdepth 1 -type d')) {
        throw new Error('PHP context artifacts should be generated for each existing locale directory');
      }
      if (!forwardWorkflow.includes('--locale "$locale"')) {
        throw new Error('translation-context-packets.js should receive the locale for PHP context artifacts');
      }
      if (!forwardWorkflow.includes('translation-context/php/${locale}')) {
        throw new Error('locale-specific context artifacts should use distinct output directories');
      }
    });

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
