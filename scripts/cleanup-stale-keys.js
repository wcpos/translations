#!/usr/bin/env node

/**
 * Remove stale keys from JS translation files.
 *
 * A "stale" key is one that exists in a translation file but not in the
 * corresponding source file.  For plural keys the script is locale-aware:
 * it keeps only the CLDR suffixes required by that locale and removes any
 * extras (e.g. _few/_many/_two for East-Asian languages).
 *
 * Usage:
 *   node scripts/cleanup-stale-keys.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const { expectedKeysForLocale } = require('./plural-rules');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_JS_DIR = path.join(ROOT, 'source/js');
const TRANSLATIONS_JS_DIR = path.join(ROOT, 'translations/js');
const LOCALES = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales.json'), 'utf8'));
const ENGLISH = new Set(['en', 'en_US', 'en_GB']);

function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Discover source files
  const projects = fs.readdirSync(SOURCE_JS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({
      name: d.name,
      files: fs.readdirSync(path.join(SOURCE_JS_DIR, d.name)).filter(f => f.endsWith('.json')),
    }));

  let totalRemoved = 0;
  let filesModified = 0;

  for (const project of projects) {
    for (const file of project.files) {
      const sourceStrings = JSON.parse(
        fs.readFileSync(path.join(SOURCE_JS_DIR, project.name, file), 'utf8')
      );
      const sourceKeys = Object.keys(sourceStrings);

      for (const locale of Object.keys(LOCALES)) {
        if (ENGLISH.has(locale)) continue;

        const transPath = path.join(TRANSLATIONS_JS_DIR, locale, project.name, file);
        if (!fs.existsSync(transPath)) continue;

        const translations = JSON.parse(fs.readFileSync(transPath, 'utf8'));
        const validKeys = expectedKeysForLocale(sourceKeys, locale);

        const keysToRemove = Object.keys(translations).filter(k => !validKeys.has(k));
        if (keysToRemove.length === 0) continue;

        console.log(`${locale}/${project.name}/${file}: removing ${keysToRemove.length} stale keys`);
        for (const k of keysToRemove) {
          console.log(`  - ${k}`);
        }

        if (!dryRun) {
          for (const k of keysToRemove) {
            delete translations[k];
          }
          const sorted = {};
          for (const k of Object.keys(translations).sort()) {
            sorted[k] = translations[k];
          }
          fs.writeFileSync(transPath, JSON.stringify(sorted, null, 2) + '\n');
        }

        totalRemoved += keysToRemove.length;
        filesModified++;
      }
    }
  }

  console.log(`\n${dryRun ? '[DRY RUN] Would remove' : 'Removed'} ${totalRemoved} stale keys from ${filesModified} files.`);
}

main();
