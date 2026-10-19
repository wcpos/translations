#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { parsePluralKey } = require('./plural-rules');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const ENGLISH_LOCALES = new Set(['en', 'en_US', 'en_GB']);
// A short, stable fingerprint is enough to detect changed source text.
const HASH_LENGTH = 16;

function hashSource(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

function syncSourceHashes({ rootDir = DEFAULT_ROOT } = {}) {
  const hashPath = path.join(rootDir, 'source/js-source-hashes.json');
  const previousText = fs.existsSync(hashPath) ? fs.readFileSync(hashPath, 'utf8') : null;
  const previous = previousText === null ? {} : JSON.parse(previousText);
  const jsDir = path.join(rootDir, 'source/js');
  const jsFiles = fs.readdirSync(jsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(project => fs.readdirSync(path.join(jsDir, project.name))
      .filter(file => file.endsWith('.json')).map(file => `${project.name}/${file}`))
    .sort();
  const locales = Object.keys(JSON.parse(fs.readFileSync(path.join(rootDir, 'locales.json'), 'utf8')))
    .filter(locale => !ENGLISH_LOCALES.has(locale));
  const hashes = {};
  const changed = [];
  let seeded = 0;
  let removed = 0;

  for (const file of jsFiles) {
    const source = JSON.parse(fs.readFileSync(path.join(jsDir, file), 'utf8'));
    hashes[file] = {};
    const changedKeys = [];
    for (const key of Object.keys(source).sort()) {
      const hash = hashSource(source[key]);
      hashes[file][key] = hash;
      const recorded = previous[file]?.[key];
      if (recorded === undefined) seeded++;
      else if (recorded !== hash) {
        changed.push({ file, key });
        changedKeys.push(key);
      }
    }
    if (!changedKeys.length) continue;
    const changedSet = new Set(changedKeys);
    const pluralBases = new Set(changedKeys.map(parsePluralKey).filter(Boolean).map(plural => plural.base));
    for (const locale of locales) {
      const translationPath = path.join(rootDir, 'translations/js', locale, file);
      if (!fs.existsSync(translationPath)) continue;
      const translations = JSON.parse(fs.readFileSync(translationPath, 'utf8'));
      let deleted = 0;
      for (const key of Object.keys(translations)) {
        const plural = parsePluralKey(key);
        if (changedSet.has(key) || (plural && pluralBases.has(plural.base))) {
          delete translations[key];
          deleted++;
        }
      }
      if (deleted) {
        fs.writeFileSync(translationPath, JSON.stringify(translations, null, 2) + '\n');
        removed += deleted;
      }
    }
  }

  const content = JSON.stringify(hashes, null, 2) + '\n';
  if (content !== previousText) fs.writeFileSync(hashPath, content);
  return { seeded, changed, removed };
}

function runCli(argv) {
  let rootDir = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option !== '--root') throw new Error(`Unknown argument: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw new Error('Missing value for --root');
    rootDir = path.resolve(value);
  }
  const { seeded, changed, removed } = syncSourceHashes({ rootDir });
  process.stdout.write(JSON.stringify({ seeded, changed: changed.length, removed,
    keys: changed.map(({ file, key }) => `${file}:${key}`) }) + '\n');
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { hashSource, syncSourceHashes };
