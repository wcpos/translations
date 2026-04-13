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
const { globSync } = require('glob');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_JS_DIR = path.join(ROOT, 'source/js');
const TRANSLATIONS_JS_DIR = path.join(ROOT, 'translations/js');
const LOCALES = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales.json'), 'utf8'));
const ENGLISH = new Set(['en', 'en_US', 'en_GB']);

const PLURAL_SUFFIXES = {
  ja: ['other'], zh: ['other'], zh_CN: ['other'], zh_TW: ['other'], ko_KR: ['other'],
  vi: ['other'], th: ['other'], id_ID: ['other'], ms_MY: ['other'],
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ru_RU: ['one', 'few', 'many', 'other'], uk: ['one', 'few', 'many', 'other'],
  pl_PL: ['one', 'few', 'many', 'other'], cs: ['one', 'few', 'many', 'other'],
  ro_RO: ['one', 'few', 'other'],
};
const DEFAULT_SUFFIXES = ['one', 'other'];

const ALL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const SUFFIX_RE = new RegExp(`^(.+)_(${ALL_SUFFIXES.join('|')})$`);

function parsePlural(key) {
  const m = key.match(SUFFIX_RE);
  return m ? { base: m[1], suffix: m[2] } : null;
}

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
      const sourceKeys = new Set(Object.keys(sourceStrings));

      // Find plural base keys in source
      const pluralBases = new Set();
      for (const k of sourceKeys) {
        const p = parsePlural(k);
        if (p) pluralBases.add(p.base);
      }

      for (const locale of Object.keys(LOCALES)) {
        if (ENGLISH.has(locale)) continue;

        const transPath = path.join(TRANSLATIONS_JS_DIR, locale, project.name, file);
        if (!fs.existsSync(transPath)) continue;

        const translations = JSON.parse(fs.readFileSync(transPath, 'utf8'));
        const suffixes = PLURAL_SUFFIXES[locale] || DEFAULT_SUFFIXES;

        // Build valid keys for this locale
        const validKeys = new Set();
        for (const k of sourceKeys) {
          const p = parsePlural(k);
          if (p && pluralBases.has(p.base)) {
            // Only add if this suffix is needed for this locale
            if (suffixes.includes(p.suffix)) {
              validKeys.add(k);
            }
          } else {
            validKeys.add(k);
          }
        }
        // Also add locale-specific plural forms that aren't in source
        for (const base of pluralBases) {
          for (const s of suffixes) {
            validKeys.add(`${base}_${s}`);
          }
        }

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
