#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildWorklist } = require('../scripts/translation-worklist');
const { applyTranslations } = require('../scripts/apply-translations');
const { parsePoFile, serializePoFile, ensurePoHeader, generateL10nPhp } = require('../scripts/po-file');

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-translations-'));
const workDir = path.join(rootDir, 'work');
const resultsDir = path.join(rootDir, 'results');
const jsFile = 'translations/js/de_DE/monorepo/core.json';
const poFile = 'translations/php/de_DE/woocommerce-pos-de_DE.po';
const phpFile = poFile.replace(/\.po$/, '.l10n.php');
const read = file => fs.readFileSync(path.join(rootDir, file), 'utf8');
function write(file, content) {
  const target = path.join(rootDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
}
function cli(...args) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/apply-translations.js'),
    '--root', rootDir, ...args], { encoding: 'utf8' });
}
const apply = () => applyTranslations({ rootDir, workDir, resultsDir });
const snapshot = files => files.map(file => [file, read(file), fs.statSync(path.join(rootDir, file)).mtimeMs]);

try {
  write('locales.json', { de_DE: 'German', fr_FR: 'French' });
  write('scripts/translation-glossary.json', {});
  write('source/js/monorepo/core.json', {
    old: 'Saved', second: 'Other', welcome: 'Hello {name}', brand: 'WooCommerce POS',
    colour: 'Colour', warning: 'WordPress',
  });
  write(jsFile, { second: 'Zweite', old: 'Gespeichert', stale: 'Erhalten' });
  write('source/js/monorepo/bad.json', { broken: 'Total {total}' });
  write('translations/js/de_DE/monorepo/bad.json', '{}\n');
  write('source/js/monorepo/new.json', { added: 'New' });
  const pot = parsePoFile([
    '#. Keep this comment\nmsgid "Tendered"\nmsgstr ""',
    'msgctxt "receipt"\nmsgid "Tendered"\nmsgstr ""',
    'msgid "%d order"\nmsgid_plural "%d orders for %s"\nmsgstr[0] ""\nmsgstr[1] ""',
    'msgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] ""\nmsgstr[1] ""',
    'msgid "Colour"\nmsgstr ""',
  ].join('\n\n'));
  write('source/php/woocommerce-pos.pot', serializePoFile('', pot.entries));
  write('source/php/other.pot', 'msgid "Other"\nmsgstr ""\n');
  const existing = pot.entries.map(entry => ({ ...entry }));
  existing[0].msgstr = 'Erhalten';
  existing[3].msgstr = '%d Artikel';
  existing[3].msgstr_plural = ['%d Artikel', ''];
  existing.push({ comments: [], msgid: 'Obsolete', msgstr: 'Alt' });
  const header = ensurePoHeader('', 'woocommerce-pos', 'de_DE');
  write(poFile, serializePoFile(header, existing));
  write(phpFile, generateL10nPhp(existing, header));
  const untouchedBlock = read(poFile).split('\n\n').find(block => block.includes('#. Keep this comment'));
  const { packets } = buildWorklist({ rootDir });
  for (const packet of packets) write(`work/${packet.locale}.json`, packet);
  fs.mkdirSync(resultsDir);
  const [packet] = packets;
  const entries = packet.php['woocommerce-pos'].entries;
  const id = msgid => entries.find(entry => entry.msgid === msgid).id;
  const initialFiles = [jsFile, poFile, phpFile, 'translations/js/de_DE/monorepo/bad.json'];
  const initial = snapshot(initialFiles);
  let report = apply();
  assert.deepEqual(report.missing_results, ['de_DE', 'fr_FR']);
  assert.deepEqual(report.files_written, []);
  assert.deepEqual(snapshot(initialFiles), initial);
  assert.ok(report.source_warnings.length > 0);
  assert.equal(report.source_warnings.filter(item => item.key === 'colour').length, 1);
  const result = { locale: 'de_DE', js: {
    'monorepo/core.json': { warning: 'Webseite', colour: 'Farbe', brand: 'WooCommerce POS',
      welcome: 'Hallo {name}', old: 'Do not overwrite', unknown: 'Ignore' },
    'monorepo/bad.json': { broken: 'Summe' }, 'monorepo/new.json': { added: 'Neu' },
    'unknown/file.json': { extra: 'Ignore' },
  }, php: {
    [id('Tendered')]: ['Bezahlt'], [id('%d order')]: ['%d Bestellung', '%d Bestellungen für %s'],
    [id('Colour')]: ['Farbe'], extra: ['Ignore'],
  } };
  write('results/de_DE.json', result);
  report = apply();
  assert.equal(report.applied, 8);
  assert.equal(report.unexpected, 4);
  assert.deepEqual(report.missing_results, ['fr_FR']);
  assert.deepEqual(report.files_written, [jsFile, 'translations/js/de_DE/monorepo/new.json', phpFile, poFile].sort());
  const translated = JSON.parse(read(jsFile));
  assert.deepEqual(Object.keys(translated), ['second', 'old', 'stale', 'welcome', 'brand', 'colour', 'warning']);
  assert.deepEqual(translated, { second: 'Zweite', old: 'Gespeichert', stale: 'Erhalten',
    welcome: 'Hallo {name}', brand: 'WCPOS', colour: 'Farbe', warning: 'Webseite' });
  assert.equal(read(jsFile), JSON.stringify(translated, null, 2) + '\n');
  assert.equal(read('translations/js/de_DE/monorepo/bad.json'), '{}\n');
  assert.equal(fs.statSync(path.join(rootDir, initialFiles[3])).mtimeMs, initial[3][2]);
  assert.ok(report.rejected.some(item => item.key === 'broken' && item.reasons.some(reason => /Placeholder/.test(reason))));
  assert.ok(report.rejected.some(item => item.key === '%d item' && item.reasons[0] === 'no translation returned'));
  assert.ok(report.warnings.some(item => item.key === 'warning' && item.warnings.some(warning => /WordPress/.test(warning))));
  assert.equal(report.source_warnings.length, 1);
  let po = parsePoFile(read(poFile));
  assert.equal(po.entries.find(entry => entry.msgctxt === 'receipt').msgstr, 'Bezahlt');
  assert.equal(po.entries.find(entry => entry.msgid === 'Tendered' && !entry.msgctxt).msgstr, 'Erhalten');
  assert.deepEqual(po.entries.find(entry => entry.msgid === '%d order').msgstr_plural, result.php[id('%d order')]);
  assert.deepEqual(po.entries.find(entry => entry.msgid === '%d item').msgstr_plural, ['%d Artikel', '']);
  assert.ok(!po.entries.some(entry => entry.msgid === 'Obsolete'));
  assert.equal(read(poFile).split('\n\n').find(block => block.includes('#. Keep this comment')), untouchedBlock);
  assert.equal(read(phpFile), generateL10nPhp(po.entries, po.header));
  assert.ok(read(phpFile).includes('Bezahlt'));
  assert.ok(!fs.existsSync(path.join(rootDir, 'translations/php/de_DE/other-de_DE.po')));
  assert.ok(!fs.existsSync(path.join(rootDir, 'translations/js/fr_FR')));
  const written = [...new Set([...initialFiles, ...report.files_written])];
  const after = snapshot(written);
  report = apply();
  assert.equal(report.applied, 0);
  assert.deepEqual(report.files_written, []);
  assert.deepEqual(snapshot(written), after);

  const count = packet.counts.js + packet.counts.php;
  for (const invalid of ['{', [], null, { locale: 'wrong', js: {}, php: {} },
    { locale: 'de_DE', js: [], php: {} }, { locale: 'de_DE', js: {}, php: [] },
    { locale: 'de_DE', js: { 'monorepo/core.json': [] }, php: {} },
    { locale: 'de_DE', js: null }, { locale: 'de_DE', php: null }, { locale: 'de_DE', js: 'x' }]) {
    write('results/de_DE.json', invalid);
    report = apply();
    assert.equal(report.rejected.length, count);
    assert.ok(report.rejected.every(item => item.reasons[0] === 'invalid results file'));
    assert.ok(report.rejected.some(item => item.key === '[receipt] Tendered'));
    assert.deepEqual(report.files_written, []);
    assert.deepEqual(snapshot(written), after);
  }
  for (const omitted of [{ locale: 'de_DE' }, { locale: 'de_DE', js: {} }, { locale: 'de_DE', php: {} }]) {
    write('results/de_DE.json', omitted);
    report = apply();
    assert.equal(report.rejected.length, count);
    assert.ok(report.rejected.every(item => item.reasons[0] === 'no translation returned'));
    assert.deepEqual(report.files_written, []);
    assert.deepEqual(snapshot(written), after);
  }
  for (const forms of [['%d Artikel'], ['%d Artikel', 7], 'text', ['Artikel', '%d Artikel'], ['%d Artikel', 'Artikel']]) {
    write('results/de_DE.json', { locale: 'de_DE', js: { 'monorepo/core.json': { welcome: 3 } }, php: { [id('%d item')]: forms } });
    report = apply();
    assert.equal(report.applied, 0);
    assert.equal(report.rejected.length, count);
    assert.ok(report.rejected.find(item => item.key === 'welcome').reasons[0].includes('strings'));
    assert.deepEqual(report.files_written, []);
    assert.deepEqual(snapshot(written), after);
  }
  write('results/de_DE.json', { locale: 'de_DE', php: { [id('%d item')]: ['%d neuer Artikel', '%d neue Artikel'] } });
  report = apply();
  assert.equal(report.applied, 1);
  po = parsePoFile(read(poFile));
  assert.deepEqual(po.entries.find(entry => entry.msgid === '%d item').msgstr_plural, ['%d neuer Artikel', '%d neue Artikel']);

  write('results/de_DE.json', result);
  let run = cli('--work', workDir, '--results', resultsDir, '--report', path.join(rootDir, 'report.json'), '--report-md', path.join(rootDir, 'report.md'));
  assert.equal(run.status, 0, run.stderr);
  const saved = JSON.parse(read('report.json'));
  assert.equal(run.stdout, JSON.stringify({ applied: 0, rejected: saved.rejected.length, warnings: saved.warnings.length, files: 0 }) + '\n');
  for (const title of ['Rejected', 'Warnings', 'Source string warnings']) assert.ok(read('report.md').includes(`## ${title}`));
  for (const args of [[], ['--work'], ['--work', workDir], ['--results', resultsDir],
    ['--work', workDir, '--results', resultsDir, '--report'], ['--unknown', 'x']]) {
    run = cli(...args);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
  }
  const many = Object.fromEntries(Array.from({ length: 52 }, (_, index) => [`key|${index}`, { source: 'WordPress' }]));
  write('work/de_DE.json', { locale: 'de_DE', js: { 'monorepo/many.json': many }, php: {} });
  write('results/de_DE.json', { locale: 'de_DE', js: {}, php: {} });
  run = cli('--work', workDir, '--results', resultsDir, '--report-md', path.join(rootDir, 'report.md'));
  assert.equal(run.status, 0, run.stderr);
  assert.ok(read('report.md').includes('…and 2 more'));
  assert.ok(read('report.md').includes('key\\|49'));
  assert.ok(!read('report.md').includes('key\\|50'));
  assert.ok(!read('report.md').includes('## Warnings'));
  write('results/de_DE.json', { locale: 'de_DE', js: { 'monorepo/many.json': Object.fromEntries(Object.keys(many).map(key => [key, 'Webseite'])) }, php: {} });
  run = cli('--work', workDir, '--results', resultsDir, '--report-md', path.join(rootDir, 'report.md'));
  assert.equal(run.status, 0, run.stderr);
  assert.ok(read('report.md').includes('…and 2 more'));
  assert.ok(read('report.md').includes('## Warnings'));
  assert.ok(!read('report.md').includes('## Rejected'));
  write('work/de_DE.json', { locale: 'de_DE', js: { 'monorepo/only.json': { hello: { source: 'Hello' } } }, php: {} });
  write('results/de_DE.json', { locale: 'de_DE', js: { 'monorepo/only.json': { hello: 'Hallo' } } });
  report = apply();
  assert.equal(report.applied, 1);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(report.files_written, ['translations/js/de_DE/monorepo/only.json']);
  assert.deepEqual(JSON.parse(read('translations/js/de_DE/monorepo/only.json')), { hello: 'Hallo' });
  console.log('Apply translations tests passed');
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}
