#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  findConsistencyWarnings,
  findLengthBudgetWarning,
  findQualityWarnings,
  isAllowedUnchangedTechnicalString,
  formatGithubAnnotations,
  formatMarkdownSummary,
  isChangedRelativePath,
  main,
  normalizePathSeparators,
  scanJsonTranslations,
  scanPoFile,
} = require('../scripts/check-translation-quality.js');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

test('allows known technical strings to remain unchanged', () => {
  assert.equal(isAllowedUnchangedTechnicalString('POS'), true);
  assert.equal(isAllowedUnchangedTechnicalString('OK'), true);
  assert.equal(isAllowedUnchangedTechnicalString('https://wordpress.org/plugins/woocommerce-pos/'), true);
  assert.equal(isAllowedUnchangedTechnicalString('Status Label'), false);
});


test('allows receipt tax labels and placeholder-only formats to remain unchanged', () => {
  for (const value of ['Codice Fiscale', 'Partita IVA', 'USt-IdNr.', 'Steuernummer', '%1$s: %2$s', 'SKU: %s', 'POS & Online', 'HTML (Offline)', 'PHP (Legacy)', 'kilbot']) {
    assert.equal(isAllowedUnchangedTechnicalString(value), true, value);
    assert.deepEqual(findQualityWarnings({ locale: 'fr_FR', msgid: value, msgstr: value }), []);
  }
});

test('matches changed translation files with Windows path separators', () => {
  const changed = new Set(['translations/php/de_DE/woocommerce-pos.po']);

  assert.equal(normalizePathSeparators('translations\\php\\de_DE\\woocommerce-pos.po'), 'translations/php/de_DE/woocommerce-pos.po');
  assert.equal(isChangedRelativePath(changed, 'translations\\php\\de_DE\\woocommerce-pos.po'), true);
  assert.equal(isChangedRelativePath(changed, 'translations\\php\\fr_FR\\woocommerce-pos.po'), false);
});

test('flags unchanged human-facing English in non-English locales', () => {
  assert.deepEqual(findQualityWarnings({ locale: 'de_DE', msgid: 'Status Label', msgstr: 'Status Label' }), [
    'human-facing English appears unchanged',
  ]);
  assert.deepEqual(findQualityWarnings({ locale: 'de_DE', msgid: 'user', msgstr: 'user' }), [
    'human-facing English appears unchanged',
  ]);
  assert.deepEqual(findQualityWarnings({ locale: 'fr_FR', msgid: 'products', msgstr: 'products' }), [
    'human-facing English appears unchanged',
  ]);
});

test('flags known awkward German WCPOS word order', () => {
  assert.deepEqual(findQualityWarnings({
    locale: 'de_DE',
    msgid: 'Order details manually sent to %s from WCPOS.',
    msgstr: 'Bestelldetails manuell an %s von WCPOS gesendet.',
  }), [
    'German phrasing is too literal; prefer natural verb placement such as "wurden von WCPOS manuell an %s gesendet"',
  ]);
});

test('flags Greek title-case UI labels', () => {
  assert.deepEqual(findQualityWarnings({ locale: 'el', msgid: 'Status Label', msgstr: 'Ετικέτα Κατάστασης' }), [
    'Greek UI labels should normally use sentence case, not English-style title case',
  ]);
});

test('flags Bulgarian missing auxiliary pattern', () => {
  assert.deepEqual(findQualityWarnings({
    locale: 'bg_BG',
    msgid: 'Order details manually sent to %s from WCPOS.',
    msgstr: 'Данните за поръчката ръчно изпратени до %s от WCPOS.',
  }), [
    'Bulgarian passive phrasing appears to be missing an auxiliary verb',
  ]);
});


test('does not flag Bulgarian passive when auxiliary is present', () => {
  assert.deepEqual(findQualityWarnings({
    locale: 'bg_BG',
    msgid: 'Order details manually sent to %s from WCPOS.',
    msgstr: 'Данните за поръчката са ръчно изпратени до %s от WCPOS.',
  }), []);
});


test('scans JSON translation values for quality warnings', () => {
  const warnings = scanJsonTranslations({
    locale: 'de_DE',
    file: 'translations/js/de_DE/example.json',
    translations: {
      status_label: 'Status Label',
      translated_label: 'Statusbezeichnung',
      ok: 'OK',
    },
    source: {
      status_label: 'Status Label',
      translated_label: 'Status Label',
      ok: 'OK',
    },
  });

  assert.deepEqual(warnings.map((item) => ({ key: item.key, warning: item.warning })), [
    { key: 'status_label', warning: 'human-facing English appears unchanged' },
  ]);
});


test('uses plural PO source text when checking unchanged plural forms', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-po-quality-'));
  const file = path.join(tempDir, 'sample.po');
  fs.writeFileSync(file, `msgid ""
msgstr ""
"Language: de_DE\n"
"Plural-Forms: nplurals=2; plural=(n != 1);\n"

msgid "product"
msgid_plural "products"
msgstr[0] "Produkt"
msgstr[1] "products"
`);

  const warnings = scanPoFile(file, 'de_DE');
  assert.deepEqual(warnings.map((item) => ({ msgid: item.msgid, form: item.form, warning: item.warning })), [
    { msgid: 'products', form: 1, warning: 'human-facing English appears unchanged' },
  ]);
});


test('uses sibling JSON plural source text for locale-specific plural keys', () => {
  const warnings = scanJsonTranslations({
    locale: 'ar',
    file: 'translations/js/ar/example.json',
    translations: {
      'cart.items_few': '{count} products',
    },
    source: {
      'cart.items_one': '{count} product',
      'cart.items_other': '{count} products',
    },
  });

  assert.deepEqual(warnings.map((item) => ({ key: item.key, msgid: item.msgid, warning: item.warning })), [
    { key: 'cart.items_few', msgid: '{count} products', warning: 'human-facing English appears unchanged' },
  ]);
});


test('formats markdown summary for GitHub job summaries', () => {
  const markdown = formatMarkdownSummary([
    {
      file: 'translations/php/de_DE/woocommerce-pos-de_DE.po',
      locale: 'de_DE',
      msgid: 'Order details manually sent to %s from WCPOS.',
      msgstr: 'Bestelldetails manuell an %s von WCPOS gesendet.',
      warning: 'German phrasing is too literal',
    },
    {
      file: 'translations/php/de_DE/woocommerce-pos-de_DE.po',
      locale: 'de_DE',
      msgid: 'Status',
      msgstr: 'Status',
      warning: 'human-facing English appears unchanged',
    },
  ], { limit: 1 });

  assert.match(markdown, /^## Translation quality smoke check/m);
  assert.match(markdown, /2 warning\(s\)/);
  assert.match(markdown, /German phrasing is too literal/);
  assert.match(markdown, /\.\.\. 1 more warning\(s\)/);
});

test('formats empty markdown summary clearly', () => {
  assert.equal(formatMarkdownSummary([]), `## Translation quality smoke check\n\nNo warnings found.`);
});

test('rejects conflicting translation quality output modes', () => {
  assert.throws(
    () => main(['--json', '--markdown']),
    /Choose only one output mode: --json, --markdown, or --github-annotations/,
  );
});


test('formats GitHub Actions warning annotations', () => {
  const annotations = formatGithubAnnotations([
    {
      file: 'translations/php/de_DE/woocommerce-pos-de_DE.po',
      msgid: 'Order details manually sent to %s from WCPOS.',
      msgstr: 'Bestelldetails manuell an %s von WCPOS gesendet.',
      warning: 'German phrasing is too literal',
    },
  ]);

  assert.equal(annotations, '::warning file=translations/php/de_DE/woocommerce-pos-de_DE.po,title=Translation quality::German phrasing is too literal: Order details manually sent to %25s from WCPOS. => Bestelldetails manuell an %25s von WCPOS gesendet.');
});

test('formats multiple GitHub Actions warning annotations separated by newlines', () => {
  const annotations = formatGithubAnnotations([
    {
      file: 'translations/php/de_DE/a.po',
      msgid: 'foo',
      msgstr: 'foo',
      warning: 'first warning',
    },
    {
      file: 'translations/php/fr_FR/b.po',
      msgid: 'bar',
      msgstr: 'bar',
      warning: 'second warning',
    },
  ]);

  const lines = annotations.split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '::warning file=translations/php/de_DE/a.po,title=Translation quality::first warning: foo => foo');
  assert.equal(lines[1], '::warning file=translations/php/fr_FR/b.po,title=Translation quality::second warning: bar => bar');
});

test('escapes GitHub Actions annotation control characters', () => {
  const annotations = formatGithubAnnotations([
    {
      file: 'translations/php/de_DE/example.po',
      msgid: `Line one\nLine two`,
      msgstr: '100% ready: yes',
      warning: 'contains colon, percent and newline',
    },
  ]);

  assert.match(annotations, /Line one Line two => 100%25 ready: yes/);
});

function makeFixtureRepo({ jsA, jsB, po, locale = 'de_DE' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-quality-consistency-'));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  };
  write('source/js/app/a.json', { 'a.cancel': 'Cancel', 'a.save': 'Save', items_one: 'Item', items_other: 'Items' });
  write('source/js/app/b.json', { 'b.cancel': 'Cancel', 'b.save': 'Save' });
  write(`translations/js/${locale}/app/a.json`, jsA);
  write(`translations/js/${locale}/app/b.json`, jsB);
  write(`translations/php/${locale}/plugin-${locale}.po`, `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n\n${po}`);
  return root;
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

test('length budget: a 3-char source warns at 12 chars in de, not at 8', () => {
  assert.equal(
    findLengthBudgetWarning({ locale: 'de_DE', msgid: 'Qty', msgstr: 'Mengenangabe' }),
    'Too long for a short label: "Qty" (3) → "Mengenangabe" (12), budget 9',
  );
  assert.equal(findLengthBudgetWarning({ locale: 'de_DE', msgid: 'Qty', msgstr: 'Anz. Stk' }), '');
});

test('length budget: ja counts wide characters twice against twice the source', () => {
  assert.equal(findLengthBudgetWarning({ locale: 'ja', msgid: 'Qty', msgstr: '数量' }), '');
  assert.equal(
    findLengthBudgetWarning({ locale: 'ja', msgid: 'Qty', msgstr: '注文された商品の数' }),
    'Too long for a short label: "Qty" (3) → "注文された商品の数" (18), budget 6',
  );
});

test('length budget skips placeholder strings and plural keys', () => {
  assert.equal(findLengthBudgetWarning({ locale: 'de_DE', msgid: '%s items', msgstr: '%s Artikel im Warenkorb' }), '');
  assert.equal(findLengthBudgetWarning({ locale: 'de_DE', msgid: '{n} left', msgstr: '{n} verbleibende Artikel' }), '');
  const root = makeFixtureRepo({
    jsA: { items_one: 'Artikel im Warenkorb', items_other: 'Artikel im Warenkorb' },
    jsB: {},
    po: 'msgid "Item"\nmsgid_plural "Items"\nmsgstr[0] "Artikel im Warenkorb"\nmsgstr[1] "Artikel im Warenkorb"\n',
  });
  assert.deepEqual(findConsistencyWarnings({ locale: 'de_DE', root }), []);
});

test('same-source drift across two JS files and one PO file gives one warning naming both variants', () => {
  const root = makeFixtureRepo({
    jsA: { 'a.cancel': 'Abbrechen', 'a.save': 'Speichern' },
    jsB: { 'b.cancel': 'Stornieren', 'b.save': 'Speichern' },
    po: 'msgid "Cancel"\nmsgstr "Abbrechen"\n\nmsgid "Save"\nmsgstr "Speichern"\n',
  });
  const warnings = findConsistencyWarnings({ locale: 'de_DE', root });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].category, 'same-source-drift');
  assert.equal(warnings[0].warning, 'Same English, different translations: "Cancel" → "Abbrechen" (plugin-de_DE.po, +1 more) | "Stornieren" (b.cancel)');
});

test('identical translations of one source give no drift warning', () => {
  const root = makeFixtureRepo({
    jsA: { 'a.cancel': 'Abbrechen', 'a.save': 'Speichern' },
    jsB: { 'b.cancel': 'Abbrechen', 'b.save': 'Speichern' },
    po: 'msgid "Cancel"\nmsgstr "Abbrechen"\n',
  });
  assert.deepEqual(findConsistencyWarnings({ locale: 'de_DE', root }), []);
});

test('changed-since: drift groups warn only when they hold a new or changed entry', () => {
  const root = makeFixtureRepo({
    jsA: { 'a.cancel': 'Abbrechen', 'a.save': 'Speichern' },
    jsB: { 'b.cancel': 'Stornieren', 'b.save': 'Speichern' },
    po: 'msgid "Save"\nmsgstr "Speichern"\n',
  });
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');

  assert.deepEqual(findConsistencyWarnings({ changedSince: base, root }), []);

  // Change an entry in the "Save" group only: the old "Cancel" drift stays silent.
  fs.writeFileSync(path.join(root, 'translations/js/de_DE/app/b.json'), JSON.stringify({ 'b.cancel': 'Stornieren', 'b.save': 'Sichern' }));
  const warnings = findConsistencyWarnings({ changedSince: base, root });
  assert.deepEqual(warnings.map((item) => ({ category: item.category, file: item.file, msgid: item.msgid })), [
    { category: 'same-source-drift', file: 'translations/js/de_DE/app/b.json', msgid: 'Save' },
  ]);
});

test('markdown summary shows per-category counts', () => {
  const markdown = formatMarkdownSummary([
    { file: 'a.po', msgid: 'Qty', msgstr: 'Mengenangabe', warning: 'w1', category: 'length-budget' },
    { file: 'a.po', msgid: 'Status', msgstr: 'Status', warning: 'human-facing English appears unchanged' },
  ]);
  assert.match(markdown, /^By category: length-budget 1, heuristic 1$/m);
});
