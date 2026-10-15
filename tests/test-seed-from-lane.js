#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { seedFromLane } = require('../scripts/seed-from-lane');
const { applyTranslations } = require('../scripts/apply-translations');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-from-lane-'));
const rootDir = path.join(temp, 'repo');
const workDir = path.join(temp, 'packets');
const outDir = path.join(temp, 'out');
const script = path.resolve(__dirname, '../scripts/seed-from-lane.js');
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function git(...args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const sources = { save: 'Save changes', checkout: 'Checkout', missing: 'Cancel', blank: 'Total', items_one: '{count} item', items_other: '{count} items' };
const translations = { save: 'Änderungen speichern', checkout: 'Kasse', blank: '  ', items_few: '{count} Artikel' };
const po = String.raw`msgid ""
msgstr ""
"Plural-Forms: nplurals=2; plural=(n != 1);\n"

msgid "Save"
msgstr "Speichern"

msgid "%d item"
msgid_plural "%d items"
msgstr[0] "%d Artikel"
msgstr[1] "%d Artikel"

msgid "%d order"
msgid_plural "%d orders"
msgstr[0] "%d Bestellung"
msgstr[1] ""

#, fuzzy
msgid "Delete"
msgstr "Löschen"

msgctxt "receipt"
msgid "Open"
msgstr "Öffnen"

msgid "%d product"
msgid_plural "%d goods"
msgstr[0] "%d Produkt"
msgstr[1] "%d Produkte"
`;
const entries = [
  { id: 'p1', msgid: 'Save', forms: 1 },
  { id: 'p2', msgid: '%d item', msgid_plural: '%d items', forms: 2 },
  { id: 'p3', msgid: '%d order', msgid_plural: '%d orders', forms: 2 },
  { id: 'p4', msgid: 'Delete', forms: 1 },
  { id: 'p5', msgctxt: 'cart', msgid: 'Open', forms: 1 },
  { id: 'p6', msgid: '%d product', msgid_plural: '%d products', forms: 2 },
].map(entry => ({ ...entry, translator_notes: [], references: [], concepts: [] }));
const packet = {
  locale: 'de', locale_name: 'German', locale_notes: null, glossary: { Save: 'Speichern' },
  counts: { js: 6, php: 7 },
  js: {
    'app/x.json': {
      save: { source: sources.save, concepts: [] },
      checkout: { source: 'Place order', concepts: [] },
      missing: { source: sources.missing, concepts: [] },
      blank: { source: sources.blank, concepts: [] },
      items_few: { source: sources.items_other, plural_category: 'few', concepts: [] },
    },
    'app/absent.json': { absent: { source: 'Absent', concepts: [] } },
  },
  php: {
    'woocommerce-pos': { nplurals: 2, plural_expression: 'n != 1', entries },
    absent: { nplurals: 2, plural_expression: 'n != 1', entries: [{ ...entries[0], id: 'p7' }] },
  },
};

try {
  write(path.join(rootDir, 'source/js/app/x.json'), sources);
  write(path.join(rootDir, 'translations/js/de/app/x.json'), translations);
  write(path.join(rootDir, 'translations/php/de/woocommerce-pos-de.po'), po);
  git('init', '-q', '--initial-branch=next');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixtures');
  write(path.join(workDir, 'de.json'), packet);
  write(path.join(workDir, 'fr.json'), { ...packet, locale: 'fr' });
  for (const dir of ['work', 'results']) write(path.join(outDir, dir, 'zz.json'), {});
  const summary = seedFromLane({ rootDir, workDir, ref: 'next', outDir });
  const result = read(path.join(outDir, 'results/de.json'));
  const work = read(path.join(outDir, 'work/de.json'));
  assert.equal(result.js['app/x.json'].save, translations.save);
  console.log('✓ identical JS source seeds the exact next translation');
  assert.ok(!Object.hasOwn(result.js['app/x.json'], 'checkout'));
  console.log('✓ different JS source is not seeded');
  for (const key of ['missing', 'blank']) assert.ok(!Object.hasOwn(result.js['app/x.json'], key));
  console.log('✓ missing and blank JS translations are not seeded');
  assert.equal(result.js['app/x.json'].items_few, translations.items_few);
  console.log('✓ JS plural category uses the English other source');
  assert.deepEqual(result.php.p1, ['Speichern']);
  console.log('✓ PHP singular seeds an array under the packet id');
  assert.deepEqual(result.php.p2, ['%d Artikel', '%d Artikel']);
  assert.ok(!Object.hasOwn(result.php, 'p3'));
  console.log('✓ PHP plural seeds complete forms and rejects partial forms');
  assert.ok(!Object.hasOwn(result.php, 'p4'));
  console.log('✓ fuzzy PHP translation is not seeded');
  for (const id of ['p5', 'p6']) assert.ok(!Object.hasOwn(result.php, id));
  console.log('✓ PHP context and plural source mismatches are not seeded');
  assert.ok(!Object.hasOwn(summary.locales, 'fr'));
  for (const dir of ['work', 'results']) assert.ok(!fs.existsSync(path.join(outDir, dir, 'fr.json')));
  console.log('✓ locale without files at the ref is ignored');
  assert.deepEqual(work, {
    ...packet, counts: { js: 2, php: 2 },
    js: { 'app/x.json': { save: packet.js['app/x.json'].save, items_few: packet.js['app/x.json'].items_few } },
    php: { 'woocommerce-pos': { ...packet.php['woocommerce-pos'], entries: entries.slice(0, 2) } },
  });
  assert.deepEqual(result, {
    locale: 'de', js: { 'app/x.json': { save: translations.save, items_few: translations.items_few } },
    php: { p1: ['Speichern'], p2: ['%d Artikel', '%d Artikel'] },
  });
  assert.deepEqual(summary, { seeded: 4, locales: { de: { js: 2, php: 2 } } });
  for (const dir of ['work', 'results']) {
    assert.ok(!fs.existsSync(path.join(outDir, dir, 'zz.json')));
    const file = path.join(outDir, dir, 'de.json');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(read(file), null, 2) + '\n');
  }
  console.log('✓ output preserves packet fields, filters items, counts seeds and removes stale files');
  const applyRoot = path.join(temp, 'apply');
  write(path.join(applyRoot, 'source/js/app/x.json'), sources);
  fs.copyFileSync(path.resolve(__dirname, '../locales.json'), path.join(applyRoot, 'locales.json'));
  const pot = entries.map(entry => [
    ...(entry.msgctxt === undefined ? [] : [`msgctxt ${JSON.stringify(entry.msgctxt)}`]),
    `msgid ${JSON.stringify(entry.msgid)}`,
    ...(entry.msgid_plural === undefined ? ['msgstr ""'] : [
      `msgid_plural ${JSON.stringify(entry.msgid_plural)}`, 'msgstr[0] ""', 'msgstr[1] ""',
    ]),
  ].join('\n')).join('\n\n') + '\n';
  write(path.join(applyRoot, 'source/php/woocommerce-pos.pot'), pot);
  const report = applyTranslations({ rootDir: applyRoot, workDir: path.join(outDir, 'work'), resultsDir: path.join(outDir, 'results') });
  assert.equal(report.applied, summary.seeded);
  assert.deepEqual(report.rejected, []);
  console.log('✓ promoted work passes applyTranslations checks end to end');
  for (const args of [['--unknown'], ['--ref'], ['--work', '--out']]) {
    const cli = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 2, cli.stderr);
    assert.match(cli.stderr, /Unknown argument|Missing value/);
  }
  const cli = spawnSync(process.execPath, [script, '--root', rootDir, '--work', workDir, '--ref', 'next', '--out', outDir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(cli.stdout).seeded, summary.seeded);
  console.log('✓ CLI rejects invalid options and prints one JSON summary line');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
