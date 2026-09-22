#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildWorklist } = require('../scripts/translation-worklist');
const { matchConcepts } = require('../scripts/translation-context-packets');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-worklist-'));
const script = path.resolve(__dirname, '../scripts/translation-worklist.js');
const out = path.join(rootDir, 'packets');
function write(file, content) {
  const target = path.join(rootDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
}
function cli(...args) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [script, '--root', rootDir, ...args], { encoding: 'utf8', env });
}
const singular = 'msgid "Tendered"\nmsgstr ""\n';
const contextual = 'msgctxt "receipt"\nmsgid "Tendered"\nmsgstr ""\n';
const plural = 'msgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] ""\nmsgstr[1] ""\n';
const translated = text => text.replace('msgstr ""', 'msgstr "translated"');
const pot = [
  'msgid ""\nmsgstr ""\n"Project-Id-Version: test\\n"\n',
  singular,
  '# ordinary comment\n#.   TrAnSlAtOrS: Receipt label.  \n#. Keep it short.\n#. translators:   \n#.\n#: a.php:1   b.php:2\n#: c.php:3\n' + contextual,
  plural,
].join('\n');

try {
  write('locales.json', { en: 'English', de_DE: 'German (Germany)', ar: 'Arabic', ja: 'Japanese', en_US: 'US', en_GB: 'UK' });
  write('scripts/translation-glossary.json', { _comment: 'ignored', de: { Cashier: 'Fallback' }, de_DE: { Cashier: 'Kassierer' } });
  write('scripts/locale-context/de_DE.md', 'German notes');
  write('source/js/monorepo/core.json', { x_one: '{count} item', x_other: '{count} items', plain: 'Tendered' });
  write('translations/js/de_DE/monorepo/core.json', { x_one: 'Ein Artikel', plain: '', stale: 'ignored' });
  write('translations/js/ar/monorepo/core.json', { plain: 'translated' });
  write('source/php/woocommerce-pos.pot', pot);
  write('translations/php/de_DE/woocommerce-pos-de_DE.po', translated(singular) + '\n' + plural.replace('msgstr[0] ""', 'msgstr[0] "Artikel"'));
  write('translations/php/ja/woocommerce-pos-ja.po', [translated(singular), translated(contextual), plural.replaceAll('""', '"translated"')].join('\n'));

  const result = buildWorklist({ rootDir });
  const [de, ar, ja] = result.packets;
  assert.equal(result.total, 15);
  assert.deepEqual(result.packets.map(p => p.locale), ['de_DE', 'ar', 'ja']);
  assert.deepEqual(result.packets.map(p => p.counts), [{ js: 1, php: 2 }, { js: 6, php: 3 }, { js: 2, php: 1 }]);
  assert.equal(de.locale_name, 'German (Germany)');
  assert.equal(de.locale_notes, 'scripts/locale-context/de_DE.md');
  assert.equal(ar.locale_notes, null);
  assert.deepEqual(de.glossary, { Cashier: 'Kassierer' });
  assert.deepEqual(ar.glossary, {});
  assert.deepEqual(de.js, { 'monorepo/core.json': { x_other: { source: '{count} items', plural_category: 'other', concepts: [] } } });
  assert.deepEqual(Object.keys(ar.js['monorepo/core.json']), ['x_one', 'x_other', 'x_zero', 'x_two', 'x_few', 'x_many']);
  for (const [key, entry] of Object.entries(ar.js['monorepo/core.json'])) {
    assert.equal(entry.source, key === 'x_one' ? '{count} item' : '{count} items');
    assert.equal(entry.plural_category, key.slice(2));
  }
  assert.deepEqual(ja.js['monorepo/core.json'].plain, { source: 'Tendered', concepts: matchConcepts('Tendered') });
  assert.ok(ja.js['monorepo/core.json'].plain.concepts.length > 0);
  assert.deepEqual(de.php['woocommerce-pos'], {
    nplurals: 2, plural_expression: 'n != 1', entries: [
      { id: 'p1', msgctxt: 'receipt', msgid: 'Tendered', forms: 1, translator_notes: ['Receipt label.', 'Keep it short.'], references: ['a.php:1', 'b.php:2', 'c.php:3'], concepts: matchConcepts('Tendered') },
      { id: 'p2', msgid: '%d item', msgid_plural: '%d items', forms: 2, translator_notes: [], references: [], concepts: [] },
    ],
  });
  assert.deepEqual(ar.php['woocommerce-pos'].entries.map(e => [e.id, e.forms]), [['p1', 1], ['p2', 1], ['p3', 6]]);
  assert.equal(ar.php['woocommerce-pos'].nplurals, 6);
  assert.equal(ja.php['woocommerce-pos'].nplurals, 1);
  assert.equal(ja.php['woocommerce-pos'].plural_expression, '0');
  assert.deepEqual(ja.php['woocommerce-pos'].entries.map(e => [e.id, e.forms]), [['p1', 1]]);
  assert.deepEqual(buildWorklist({ rootDir, locales: ['ar', 'de_DE', 'ar', 'en'] }).packets, [de, ar]);
  assert.deepEqual(buildWorklist({ rootDir, locales: [] }), { total: 0, packets: [] });
  assert.throws(() => buildWorklist({ rootDir, locales: ['unknown'] }), /locale/i);
  assert.deepEqual(buildWorklist({ rootDir }), result);

  let run = cli('--out', out);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, JSON.stringify({ total: 15, locales: { de_DE: de.counts, ar: ar.counts, ja: ja.counts } }) + '\n');
  for (const packet of result.packets) {
    assert.equal(fs.readFileSync(path.join(out, `${packet.locale}.json`), 'utf8'), JSON.stringify(packet, null, 2) + '\n');
  }
  write('packets/stale.json', '{}');
  write('packets/keep.txt', 'keep');
  write('stale-target.txt', 'preserved');
  fs.symlinkSync(path.join(rootDir, 'stale-target.txt'), path.join(out, 'stale-link.json'));
  run = cli('--out', out, '--locale', 'de_DE', '--locale', 'en');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { total: 3, locales: { de_DE: de.counts } });
  assert.deepEqual(fs.readdirSync(out).sort(), ['de_DE.json', 'keep.txt']);
  assert.equal(fs.readFileSync(path.join(rootDir, 'stale-target.txt'), 'utf8'), 'preserved');
  for (const args of [[], ['--out'], ['--out', out, '--locale'], ['--out', out, '--root'], ['--out', out, '--locale', 'unknown'], ['--out', out, '--wat'], ['--out', out, 'extra'], ['--out', out, '--changed-since', 'HEAD']]) {
    run = cli(...args);
    assert.equal(run.status, 2, JSON.stringify(args) + run.stderr);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.trim());
  }

  write('translations/js/ja/monorepo/core.json', { x_other: 'translated', plain: 'translated' });
  write('translations/php/ja/woocommerce-pos-ja.po', [translated(singular), translated(contextual), plural.replace('msgstr[0] ""', 'msgstr[0] "translated"').replace('msgstr[1] ""\n', '')].join('\n'));
  assert.deepEqual(buildWorklist({ rootDir, locales: ['ja', 'en', 'en_US', 'en_GB'] }), { total: 0, packets: [] });
  run = cli('--out', out, '--locale', 'ja');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '{"total":0,"locales":{}}\n');
  assert.deepEqual(fs.readdirSync(out), ['keep.txt']);
  assert.equal(buildWorklist({ rootDir }).packets.length, 2);

  fs.unlinkSync(path.join(rootDir, 'scripts/locale-context/de_DE.md'));
  write('scripts/locale-context/de.md', 'Language notes');
  write('scripts/translation-glossary.json', { _comment: 'ignored', de: { Cashier: 'Fallback' } });
  const fallback = buildWorklist({ rootDir, locales: ['de_DE'] }).packets[0];
  assert.equal(fallback.locale_notes, 'scripts/locale-context/de.md');
  assert.deepEqual(fallback.glossary, { Cashier: 'Fallback' });
  write('source/php/z-domain.pot', singular);
  write('source/php/a-domain.pot', singular);
  write('source/js/z-project/z.json', { z: 'Zed' });
  write('source/js/a-project/z.json', { z: 'Zed' });
  write('source/js/a-project/a.json', { a: 'Alpha' });
  write('source/js/monorepo/complete.json', { complete: 'Complete' });
  write('translations/js/de_DE/monorepo/complete.json', { complete: 'translated' });
  const ordered = buildWorklist({ rootDir, locales: ['de_DE'] }).packets[0];
  assert.deepEqual(Object.keys(ordered.js), ['a-project/a.json', 'a-project/z.json', 'monorepo/core.json', 'z-project/z.json']);
  assert.deepEqual(Object.keys(ordered.php), ['a-domain', 'woocommerce-pos', 'z-domain']);
  assert.deepEqual(Object.values(ordered.php).flatMap(d => d.entries.map(e => e.id)), ['p1', 'p2', 'p3', 'p4']);
  write('translations/php/de_DE/a-domain-de_DE.po', translated(singular));
  assert.deepEqual(Object.keys(buildWorklist({ rootDir, locales: ['de_DE'] }).packets[0].php), ['woocommerce-pos', 'z-domain']);
  console.log('Translation worklist tests passed');
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}
