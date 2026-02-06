#!/usr/bin/env node

/**
 * Generate base language fallback locales.
 *
 * For regional variants (e.g., de_DE, de_AT), we also need a base code (de)
 * which is a straight copy of the primary variant. This avoids requiring
 * separate translations for each regional variant when the base language
 * doesn't exist as its own locale.
 *
 * Usage:
 *   node scripts/generate-fallbacks.js
 */

const fs = require('fs');
const path = require('path');

const TRANSLATIONS_JS_DIR = path.resolve(__dirname, '../translations/js');
const TRANSLATIONS_PHP_DIR = path.resolve(__dirname, '../translations/php');

// Base language code → primary regional variant to copy from
const FALLBACK_MAP = {
  de: 'de_DE',
  en: 'en_US',
  es: 'es_ES',
  fr: 'fr_FR',
  nl: 'nl_NL',
  pt: 'pt_PT',
  zh: 'zh_CN',
};

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let generated = 0;
let skipped = 0;

for (const [baseCode, sourceVariant] of Object.entries(FALLBACK_MAP)) {
  // JS: copy entire directory tree
  const jsSource = path.join(TRANSLATIONS_JS_DIR, sourceVariant);
  const jsDest = path.join(TRANSLATIONS_JS_DIR, baseCode);

  if (fs.existsSync(jsSource)) {
    copyDirSync(jsSource, jsDest);
    console.log(`  ✓ JS: ${baseCode} ← ${sourceVariant}`);
    generated++;
  } else {
    console.log(`  ○ JS: ${baseCode} skipped (${sourceVariant} not found)`);
    skipped++;
  }

  // PHP: copy and rename files (locale code is in the filename)
  const phpSource = path.join(TRANSLATIONS_PHP_DIR, sourceVariant);
  const phpDest = path.join(TRANSLATIONS_PHP_DIR, baseCode);

  if (fs.existsSync(phpSource)) {
    fs.mkdirSync(phpDest, { recursive: true });
    const files = fs.readdirSync(phpSource);
    for (const file of files) {
      // Rename: woocommerce-pos-de_DE.po → woocommerce-pos-de.po
      const renamed = file.replace(sourceVariant, baseCode);
      fs.copyFileSync(path.join(phpSource, file), path.join(phpDest, renamed));
    }
    console.log(`  ✓ PHP: ${baseCode} ← ${sourceVariant}`);
    generated++;
  } else {
    console.log(`  ○ PHP: ${baseCode} skipped (${sourceVariant} not found)`);
    skipped++;
  }
}

console.log(`\nDone: ${generated} generated, ${skipped} skipped`);
