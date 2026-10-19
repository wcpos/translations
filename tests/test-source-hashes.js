#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashSource, syncSourceHashes } = require('../scripts/source-hashes');
const { buildWorklist } = require('../scripts/translation-worklist');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-hashes-'));
const script = path.resolve(__dirname, '../scripts/source-hashes.js');
function write(file, content) {
  const target = path.join(rootDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

try {
  write('locales.json', { en: 'English', en_GB: 'UK', de_DE: 'German', ar: 'Arabic' });
  write('scripts/translation-glossary.json', {});
  fs.mkdirSync(path.join(rootDir, 'source/php'), { recursive: true });
  write('source/js/monorepo/core.json', {
    'tax.rate': 'Rate %', 'tax.name': 'Tax name', x_one: '{n} item', x_other: '{n} items',
  });
  write('source/js/electron/electron.json', { quit: 'Quit' });
  const germanFile = 'translations/js/de_DE/monorepo/core.json';
  const arabicFile = 'translations/js/ar/monorepo/core.json';
  const englishFile = 'translations/js/en/monorepo/core.json';
  write(germanFile, {
    x_other: '{n} Artikel', 'tax.rate': 'Satz %', x_one: '{n} Artikel', 'tax.name': 'Steuername',
  });
  write(arabicFile, {
    'tax.rate': 'معدل', 'tax.name': 'اسم', x_zero: 'صفر', x_one: 'واحد',
    x_two: 'اثنان', x_few: 'قليل', x_many: 'كثير', x_other: 'آخر',
  });
  write(englishFile, { 'tax.rate': 'Rate %' });
  const before = [germanFile, arabicFile, englishFile]
    .map(file => fs.readFileSync(path.join(rootDir, file), 'utf8'));
  const hashPath = path.join(rootDir, 'source/js-source-hashes.json');

  let result = syncSourceHashes({ rootDir });
  assert.equal(result.seeded, 5);
  assert.deepEqual(result.changed, []);
  assert.equal(result.removed, 0);
  const hashes = JSON.parse(fs.readFileSync(hashPath, 'utf8'));
  assert.deepEqual(hashes, {
    'electron/electron.json': { quit: hashSource('Quit') },
    'monorepo/core.json': {
      'tax.name': hashSource('Tax name'), 'tax.rate': hashSource('Rate %'),
      x_one: hashSource('{n} item'), x_other: hashSource('{n} items'),
    },
  });
  assert.deepEqual(Object.keys(hashes), ['electron/electron.json', 'monorepo/core.json']);
  assert.deepEqual(Object.keys(hashes['monorepo/core.json']), ['tax.name', 'tax.rate', 'x_one', 'x_other']);
  assert.deepEqual([germanFile, arabicFile, englishFile]
    .map(file => fs.readFileSync(path.join(rootDir, file), 'utf8')), before);

  write('source/js/monorepo/core.json', {
    'tax.rate': 'Rate', x_one: '{n} item', x_other: '{n} things', 'new.key': 'New',
  });
  result = syncSourceHashes({ rootDir });
  assert.deepEqual(result.changed, [
    { file: 'monorepo/core.json', key: 'tax.rate' },
    { file: 'monorepo/core.json', key: 'x_other' },
  ]);
  assert.equal(result.seeded, 1);
  assert.equal(result.removed, 10);
  assert.equal(fs.readFileSync(path.join(rootDir, germanFile), 'utf8'),
    JSON.stringify({ 'tax.name': 'Steuername' }, null, 2) + '\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, arabicFile), 'utf8')),
    { 'tax.name': 'اسم' });
  assert.equal(fs.readFileSync(path.join(rootDir, englishFile), 'utf8'), before[2]);
  const changedHashText = fs.readFileSync(hashPath, 'utf8');
  const changedHashes = JSON.parse(changedHashText);
  assert.ok(!Object.hasOwn(changedHashes['monorepo/core.json'], 'tax.name'));
  assert.equal(changedHashes['monorepo/core.json']['tax.rate'], hashSource('Rate'));

  const german = buildWorklist({ rootDir }).packets.find(packet => packet.locale === 'de_DE');
  const missing = german.js['monorepo/core.json'];
  assert.equal(missing['tax.rate'].source, 'Rate');
  assert.deepEqual(Object.keys(missing), ['tax.rate', 'x_one', 'x_other', 'new.key']);
  assert.ok(!Object.hasOwn(missing, 'tax.name'));

  assert.deepEqual(syncSourceHashes({ rootDir }), { seeded: 0, changed: [], removed: 0 });
  assert.equal(fs.readFileSync(hashPath, 'utf8'), changedHashText);

  const cli = spawnSync(process.execPath, [script, '--root', rootDir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { seeded: 0, changed: 0, removed: 0, keys: [] });
  const unknown = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown argument: --bogus/);
  console.log('source hash checks passed');
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}
