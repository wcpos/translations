#!/usr/bin/env node

/**
 * Validate translation files for structural correctness.
 * Checks JSON, PO, and PHP files for validity.
 *
 * Usage: node scripts/validate-translations.js [locale] [--php-only]
 *
 * Options:
 *   locale      Optional locale to validate (e.g. de_DE)
 *   --php-only  Only validate .l10n.php files (for CI after generation)
 *
 * Exit code 1 on any validation failure.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { globSync } = require('glob');
const gettextParser = require('gettext-parser');

const TRANSLATIONS_JS_DIR = path.resolve(__dirname, '../translations/js');
const TRANSLATIONS_PHP_DIR = path.resolve(__dirname, '../translations/php');

/**
 * Check whether php is available on this system.
 *
 * @returns {boolean}
 */
function hasPhp() {
  try {
    execSync('php -v', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate JSON translation files.
 *
 * @param {string|null} locale
 * @returns {{ total: number, errors: number }}
 */
function validateJson(locale) {
  const pattern = locale
    ? path.join(TRANSLATIONS_JS_DIR, locale, '**', '*.json')
    : path.join(TRANSLATIONS_JS_DIR, '**', '*.json');

  const files = globSync(pattern);
  let errors = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      JSON.parse(content);
    } catch (e) {
      console.error(`[JSON] Invalid: ${file} — ${e.message}`);
      errors++;
    }
  }

  return { total: files.length, errors };
}

/**
 * Validate .po translation files using gettext-parser.
 * Checks that the file parses and has required headers.
 *
 * @param {string|null} locale
 * @returns {{ total: number, errors: number }}
 */
function validatePo(locale) {
  const pattern = locale
    ? path.join(TRANSLATIONS_PHP_DIR, locale, '*.po')
    : path.join(TRANSLATIONS_PHP_DIR, '**', '*.po');

  const files = globSync(pattern);
  let errors = 0;

  const requiredHeaders = ['content-type'];
  const recommendedHeaders = ['plural-forms'];
  let warnings = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file);
      const parsed = gettextParser.po.parse(content);

      const headers = parsed.headers || {};
      const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());

      for (const required of requiredHeaders) {
        if (!headerKeys.includes(required)) {
          console.error(`[PO] Missing required header "${required}": ${file}`);
          errors++;
        }
      }

      for (const recommended of recommendedHeaders) {
        if (!headerKeys.includes(recommended)) {
          console.warn(
            `[PO] Warning: missing header "${recommended}": ${file}`
          );
          warnings++;
        }
      }
    } catch (e) {
      console.error(`[PO] Invalid: ${file} — ${e.message}`);
      errors++;
    }
  }

  if (warnings > 0) {
    console.warn(`  PO: ${warnings} warning(s) for missing recommended headers`);
  }

  return { total: files.length, errors };
}

/**
 * Validate .l10n.php translation files.
 * Runs php -l for syntax checking and verifies the returned array
 * has the expected 'messages' key.
 *
 * @param {string|null} locale
 * @returns {{ total: number, errors: number }}
 */
function validatePhp(locale) {
  const phpAvailable = hasPhp();
  if (!phpAvailable) {
    console.warn(
      '[PHP] Warning: php not found in PATH — skipping PHP validation'
    );
    return { total: 0, errors: 0 };
  }

  const pattern = locale
    ? path.join(TRANSLATIONS_PHP_DIR, locale, '*.l10n.php')
    : path.join(TRANSLATIONS_PHP_DIR, '**', '*.l10n.php');

  const files = globSync(pattern);
  let errors = 0;

  for (const file of files) {
    // Syntax check
    try {
      execSync(`php -l ${JSON.stringify(file)}`, { stdio: 'pipe' });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
      console.error(`[PHP] Syntax error: ${file} — ${stderr}`);
      errors++;
      continue;
    }

    // Structure check: verify file returns an array with 'messages' key
    try {
      const phpCode = [
        '<?php',
        `$result = require '${file.replace(/'/g, "\\'")}';`,
        'if (!is_array($result)) { fwrite(STDERR, "File does not return an array"); exit(1); }',
        "if (!array_key_exists('messages', $result)) { fwrite(STDERR, \"Missing 'messages' key\"); exit(1); }",
        "if (!is_array($result['messages'])) { fwrite(STDERR, \"'messages' is not an array\"); exit(1); }",
      ].join('\n');
      execSync('php', { input: phpCode, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
      console.error(`[PHP] Invalid structure: ${file} — ${stderr}`);
      errors++;
    }
  }

  return { total: files.length, errors };
}

function main() {
  const args = process.argv.slice(2);
  const phpOnly = args.includes('--php-only');
  const locale = args.find((a) => !a.startsWith('--')) || null;

  let totalFiles = 0;
  let totalErrors = 0;

  if (phpOnly) {
    console.log('Validating .l10n.php files...');
    const php = validatePhp(locale);
    totalFiles += php.total;
    totalErrors += php.errors;
    console.log(`  PHP: ${php.total} files, ${php.errors} error(s)`);
  } else {
    console.log('Validating JSON files...');
    const json = validateJson(locale);
    totalFiles += json.total;
    totalErrors += json.errors;
    console.log(`  JSON: ${json.total} files, ${json.errors} error(s)`);

    console.log('Validating PO files...');
    const po = validatePo(locale);
    totalFiles += po.total;
    totalErrors += po.errors;
    console.log(`  PO: ${po.total} files, ${po.errors} error(s)`);

    console.log('Validating .l10n.php files...');
    const php = validatePhp(locale);
    totalFiles += php.total;
    totalErrors += php.errors;
    console.log(`  PHP: ${php.total} files, ${php.errors} error(s)`);
  }

  console.log(
    `\nTotal: ${totalFiles} files validated, ${totalErrors} error(s).`
  );

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main();
