#!/usr/bin/env node

/**
 * Test suite for extract-js-strings.js
 *
 * Runs extraction against test fixtures and validates:
 * - Correct strings are extracted
 * - Namespaces are assigned correctly
 * - Warnings are generated for edge cases
 * - Trans components are handled
 *
 * Usage: node tests/test-extraction.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const OUTPUT_DIR = path.resolve(__dirname, 'output');
const EXTRACT_SCRIPT = path.resolve(__dirname, '../scripts/extract-js-strings.js');

let passed = 0;
let failed = 0;

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

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n    Expected: ${JSON.stringify(expected)}\n    Actual: ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(array, item, message) {
  if (!array.includes(item)) {
    throw new Error(`${message}\n    Array does not include: ${item}\n    Array: ${JSON.stringify(array)}`);
  }
}

function assertContains(str, substring, message) {
  if (!str.includes(substring)) {
    throw new Error(`${message}\n    String does not contain: "${substring}"`);
  }
}

function setup() {
  // Clean output directory
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function runExtraction() {
  // Run extraction and capture both stdout and stderr
  const result = spawnSync('node', [EXTRACT_SCRIPT, FIXTURES_DIR], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env },
  });
  return (result.stdout || '') + (result.stderr || '');
}

function loadOutput(namespace) {
  const filePath = path.resolve(__dirname, `../source/js/${namespace}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Store original source/js contents to restore later
let originalSourceJs = {};

function backupSourceJs() {
  const sourceJsDir = path.resolve(__dirname, '../source/js');
  if (fs.existsSync(sourceJsDir)) {
    const files = fs.readdirSync(sourceJsDir);
    for (const file of files) {
      const filePath = path.join(sourceJsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        originalSourceJs[file] = fs.readFileSync(filePath, 'utf8');
      }
    }
  }
}

function restoreSourceJs() {
  const sourceJsDir = path.resolve(__dirname, '../source/js');

  // Remove any files created during test
  if (fs.existsSync(sourceJsDir)) {
    const files = fs.readdirSync(sourceJsDir);
    for (const file of files) {
      const filePath = path.join(sourceJsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.isFile() && !originalSourceJs[file]) {
        fs.unlinkSync(filePath);
      }
    }
  }

  // Restore original files
  for (const [file, content] of Object.entries(originalSourceJs)) {
    fs.writeFileSync(path.join(sourceJsDir, file), content);
  }
}

async function main() {
  console.log('Testing extract-js-strings.js\n');

  setup();
  backupSourceJs();

  const output = runExtraction();

  console.log('--- Extraction Output ---');
  console.log(output);
  console.log('-------------------------\n');

  // Load extracted files
  const core = loadOutput('core');
  const electron = loadOutput('electron');
  const pro = loadOutput('pro');
  const legacy = loadOutput('legacy');

  console.log('Testing namespace mapping...');

  test('core namespace contains basic strings', () => {
    if (!core) throw new Error('core.json not created');
    assertIncludes(Object.keys(core), 'Welcome to WCPOS', 'Missing basic string');
    assertIncludes(Object.keys(core), 'This is a test string', 'Missing basic string');
    assertIncludes(Object.keys(core), 'Double quoted string', 'Missing double-quoted string');
  });

  test('electron namespace contains electron strings', () => {
    if (!electron) throw new Error('electron.json not created');
    assertIncludes(Object.keys(electron), 'File', 'Missing electron menu string');
    assertIncludes(Object.keys(electron), 'Quit Application', 'Missing electron string');
    assertIncludes(Object.keys(electron), 'About WCPOS', 'Missing electron string');
  });

  test('explicit ns override creates separate namespace', () => {
    if (!pro) throw new Error('pro.json not created');
    assertIncludes(Object.keys(pro), 'Pro Feature', 'Missing explicit ns string');
  });

  test('legacy _tags style still works', () => {
    if (!legacy) throw new Error('legacy.json not created');
    assertIncludes(Object.keys(legacy), 'Legacy tags style', 'Missing legacy _tags string');
  });

  console.log('\nTesting context extraction...');

  test('context is extracted correctly', () => {
    if (!core) throw new Error('core.json not created');
    // Check that contextual strings are present
    // The key format for context is "string_context"
    const keys = Object.keys(core);
    const hasButtonContext = keys.some(k => core[k].context === 'button');
    const hasStatusContext = keys.some(k => core[k].context === 'status');
    if (!hasButtonContext) throw new Error('Missing button context');
    if (!hasStatusContext) throw new Error('Missing status context');
  });

  console.log('\nTesting Trans component extraction...');

  test('Trans i18nKey strings are extracted', () => {
    if (!core) throw new Error('core.json not created');
    assertIncludes(Object.keys(core), 'Welcome back, user!', 'Missing Trans string');
    assertIncludes(Object.keys(core), 'Click <bold>here</bold> for more', 'Missing Trans with tags');
    assertIncludes(Object.keys(core), 'Single quoted i18nKey', 'Missing single-quoted Trans');
    assertIncludes(Object.keys(core), 'Multiline Trans component', 'Missing multiline Trans');
  });

  console.log('\nTesting placeholder strings...');

  test('placeholder strings are extracted', () => {
    if (!core) throw new Error('core.json not created');
    assertIncludes(Object.keys(core), 'Hello {name}', 'Missing placeholder string');
    assertIncludes(Object.keys(core), 'You have {count} items', 'Missing placeholder string');
  });

  console.log('\nTesting edge cases...');

  test('template literal without interpolation works', () => {
    if (!core) throw new Error('core.json not created');
    assertIncludes(Object.keys(core), 'Template literal string', 'Missing template literal');
  });

  test('warning generated for interpolated template literal', () => {
    assertContains(output, 'Warning: interpolated template literal', 'Missing interpolation warning');
  });

  test('warning generated for unmapped namespace', () => {
    assertContains(output, 'Warning:', 'Should have warnings for unmapped files');
    assertContains(output, 'Unmapped string without namespace', 'Should warn about unmapped string');
  });

  test('explicit ns in unmapped file still works', () => {
    if (!core) throw new Error('core.json not created');
    assertIncludes(Object.keys(core), 'Mapped via explicit ns', 'Missing explicitly mapped string from unmapped file');
  });

  console.log('\nTesting file references...');

  test('file paths are recorded', () => {
    if (!core) throw new Error('core.json not created');
    const entry = core['Welcome to WCPOS'];
    if (!entry || !entry.files || entry.files.length === 0) {
      throw new Error('File paths not recorded');
    }
    if (!entry.files[0].includes('basic.tsx')) {
      throw new Error(`Expected file path to include basic.tsx, got: ${entry.files[0]}`);
    }
  });

  // Restore original files
  restoreSourceJs();

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
