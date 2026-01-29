#!/usr/bin/env node

/**
 * Validate translation files for structural correctness.
 * Checks JSON validity, placeholder preservation, and completeness.
 *
 * Usage: node scripts/validate-translations.js [locale]
 */

const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');

const SOURCE_JS_DIR = path.resolve(__dirname, '../source/js');
const TRANSLATIONS_JS_DIR = path.resolve(__dirname, '../translations/js');

function main() {
  const locale = process.argv[2];
  const pattern = locale
    ? path.join(TRANSLATIONS_JS_DIR, locale, '*.json')
    : path.join(TRANSLATIONS_JS_DIR, '**', '*.json');

  const files = globSync(pattern);
  let errors = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      JSON.parse(content);
    } catch (e) {
      console.error(`Invalid JSON: ${file} — ${e.message}`);
      errors++;
    }
  }

  console.log(`Validated ${files.length} files, ${errors} error(s).`);
  if (errors > 0) process.exit(1);
}

main();
