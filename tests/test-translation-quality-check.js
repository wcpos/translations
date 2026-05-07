#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  findQualityWarnings,
  isAllowedUnchangedTechnicalString,
  formatMarkdownSummary,
  isChangedRelativePath,
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
