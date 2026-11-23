#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { applyCorrections } = require('../scripts/apply-corrections');
const { parsePoFile, serializePoFile, ensurePoHeader, generateL10nPhp, compileMo } = require('../scripts/po-file');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-corrections-'));
const jsFile = 'translations/js/de_DE/monorepo/core.json';
const proFile = 'translations/js/de_DE/woocommerce-pos-pro/store.json';
const poFile = 'translations/php/de_DE/woocommerce-pos-de_DE.po';
const phpFile = poFile.replace(/\.po$/, '.l10n.php');
const moFile = poFile.replace(/\.po$/, '.mo');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function write(file, content) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
const allFiles = [jsFile, proFile, poFile, phpFile, moFile];
const snapshot = () => allFiles.map((file) => [file, read(file)]);

const corrections = [
  { locale: 'de_DE', key: 'common.sync', from: ['Synchronisierung'], to: 'Sync' },
  { locale: 'de_DE', key: 'common.ok', from: ['In Ordnung'], to: 'OK' },
  { locale: 'de_DE', source: ['Retry', 'Try again'], from: ['Erneut versuchen'], to: 'Wiederholen' },
  { locale: 'de_DE', key: 'po:Qty', from: ['Menge'], to: 'Anz.' },
];

try {
  write('source/js/monorepo/core.json', JSON.stringify({
    'zeta.last': 'Last', 'common.sync': 'Sync', 'common.ok': 'OK', 'common.retry': 'Retry',
    'register.try_again': ' Try again ', 'alpha.first': 'First',
  }));
  write('source/js/woocommerce-pos-pro/store.json', JSON.stringify({ 'common.retry': 'Retry' }));
  // Key order deliberately not alphabetical; four-space indent.
  write(jsFile, `${JSON.stringify({
    'zeta.last': 'Letzte', 'common.sync': 'Synchronisierung', 'common.ok': 'Passt',
    'common.retry': 'Erneut versuchen', 'register.try_again': 'Erneut versuchen', 'alpha.first': 'Erste',
  }, null, 4)}\n`);
  write(proFile, `${JSON.stringify({ 'common.retry': 'Nochmal' }, null, 2)}\n`);
  const header = ensurePoHeader('', 'woocommerce-pos', 'de_DE');
  const po = parsePoFile([
    'msgid "Qty"\nmsgstr "Menge"',
    'msgctxt "short receipt table header"\nmsgid "Qty"\nmsgstr "Menge"',
    'msgid "Quantity"\nmsgstr "Menge"',
    'msgid "Retry"\nmsgstr "Erneut versuchen"',
  ].join('\n\n'));
  write(poFile, serializePoFile(header, po.entries));
  const written = parsePoFile(read(poFile));
  write(phpFile, generateL10nPhp(written.entries, written.header));
  fs.writeFileSync(path.join(root, moFile), compileMo(written.entries, written.header));
  const before = snapshot();

  // (e) dry-run writes nothing, but reports the changes.
  const dry = applyCorrections({ root, corrections, dryRun: true });
  assert.deepEqual(snapshot(), before, 'dry-run must not write');
  assert.equal(dry.totals.change, 6);
  assert.match(dry.markdown, /# Corrections \(dry run\)/);

  // CLI dry-run with --root also writes nothing.
  const correctionsPath = path.join(root, 'corrections.json');
  fs.writeFileSync(correctionsPath, JSON.stringify({ corrections }));
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/apply-corrections.js'),
    correctionsPath, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /CHANGE js\/de_DE\/monorepo\/core.json common.sync: "Synchronisierung" → "Sync"/);
  assert.deepEqual(snapshot(), before, 'CLI dry-run must not write');

  const result = applyCorrections({ root, corrections });
  const core = JSON.parse(read(jsFile));
  // (a) a key correction applies when the current value is in from.
  assert.equal(core['common.sync'], 'Sync');
  // (b) a differing value is left alone and reported UNMATCHED.
  assert.equal(core['common.ok'], 'Passt');
  assert.match(result.markdown, /UNMATCHED[\s\S]*#1 key common\.ok: js\/de_DE\/monorepo\/core\.json common\.ok current "Passt"/);
  // (c) a source correction applies to both keys with the same English (trimmed),
  // to the PO msgid, and not to a key whose value is not in from.
  assert.equal(core['common.retry'], 'Wiederholen');
  assert.equal(core['register.try_again'], 'Wiederholen');
  assert.equal(JSON.parse(read(proFile))['common.retry'], 'Nochmal');
  assert.match(result.markdown, /woocommerce-pos-pro\/store\.json common\.retry current "Nochmal"/);
  // (d) a PO msgid correction rewrites only that msgstr (every context), and regenerates
  // the .l10n.php and .mo from the written PO.
  const after = parsePoFile(read(poFile));
  const msgstr = (msgid, msgctxt) => after.entries.find((e) => e.msgid === msgid && e.msgctxt === msgctxt).msgstr;
  assert.equal(msgstr('Qty'), 'Anz.');
  assert.equal(msgstr('Qty', 'short receipt table header'), 'Anz.');
  assert.equal(msgstr('Quantity'), 'Menge');
  assert.equal(msgstr('Retry'), 'Wiederholen');
  const expectedPo = before.find(([file]) => file === poFile)[1]
    .replace(/msgid "Qty"\nmsgstr "Menge"/g, 'msgid "Qty"\nmsgstr "Anz."')
    .replace('msgid "Retry"\nmsgstr "Erneut versuchen"', 'msgid "Retry"\nmsgstr "Wiederholen"');
  assert.equal(read(poFile), expectedPo, 'only the corrected msgstr lines change');
  assert.equal(read(phpFile), generateL10nPhp(after.entries, after.header));
  assert.ok(fs.readFileSync(path.join(root, moFile)).equals(compileMo(after.entries, after.header)));
  assert.equal(result.totals.change, 6);
  assert.equal(result.totals.unmatched, 2);

  // (g) JSON key order and indent are preserved; only corrected values differ.
  const expectedJs = before.find(([file]) => file === jsFile)[1]
    .replace('"common.sync": "Synchronisierung"', '"common.sync": "Sync"')
    .replace(/"Erneut versuchen"/g, '"Wiederholen"');
  assert.equal(read(jsFile), expectedJs);

  // (f) a second run is a no-op.
  const applied = snapshot();
  const again = applyCorrections({ root, corrections });
  assert.equal(again.totals.change, 0);
  assert.equal(again.totals.already, 6);
  assert.deepEqual(snapshot(), applied, 'second run must not change files');

  // A placeholder change is refused even when the guard matches.
  write(jsFile, `${JSON.stringify({ 'zeta.last': '{n} Letzte' }, null, 4)}\n`);
  const refused = applyCorrections({ root,
    corrections: [{ locale: 'de_DE', key: 'zeta.last', from: ['{n} Letzte'], to: 'Letzte' }] });
  assert.equal(refused.totals.change, 0);
  assert.match(refused.markdown, /placeholder mismatch/);

  // A malformed correction is rejected.
  assert.throws(() => applyCorrections({ root, corrections: [{ locale: 'de_DE', from: ['x'], to: 'y' }] }),
    /exactly one of key\/source/);

  console.log('test-apply-corrections: ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
