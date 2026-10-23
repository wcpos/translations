#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { PLURAL_SUFFIXES, ONE_IS_EXACTLY_ONE, placeholdersMatch, pluralBasesOf, expectedKeysForLocale } = require('../scripts/plural-rules.js');

const {
  findWcposNamingIssues,
  createTriageSummary,
  recordTriageIssue,
  serializeTriageSummary,
  parseCliOptions,
  parseGitChangedFiles,
  createChangedScope,
  shouldCheckPhpPoFile,
  parsePluralFormsHeader,
  l10nHasPluralFormsHeader,
  sourceTextForTranslationKey,
} = require('../scripts/check-completeness.js');

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

function oneIntegers(locale) {
  const rules = new Intl.PluralRules(locale.replace(/_/g, '-'));
  return Array.from({ length: 1001 }, (_, n) => n).filter(n => rules.select(n) === 'one');
}

test('count-free singular locales are pinned to ICU with explicit publication exclusions', () => {
  const excluded = new Set(['pt_PT', 'en', 'en_GB', 'en_US']);
  const locales = new Set([...Object.keys(PLURAL_SUFFIXES), ...Object.keys(require('../locales.json'))]);
  const expected = [...locales].filter(locale =>
    JSON.stringify(oneIntegers(locale)) === '[1]' && !excluded.has(locale));
  assert.deepEqual([...(ONE_IS_EXACTLY_ONE || [])].sort(), expected.sort());
});

test('fallback copies of relaxed locales also use one only for 1', () => {
  // Read only the map literal: requiring this script would regenerate catalogues.
  const script = fs.readFileSync(path.join(__dirname, '../scripts/generate-fallbacks.js'), 'utf8');
  const map = require('node:vm').runInNewContext(`(${script.match(/const FALLBACK_MAP = (\{[\s\S]*?\});/)[1]})`);
  assert.ok(ONE_IS_EXACTLY_ONE instanceof Set);
  assert.equal(ONE_IS_EXACTLY_ONE.has('pt_PT'), false);
  assert.deepEqual(oneIntegers('pt_PT'), [1]);
  assert.deepEqual(oneIntegers('pt'), [0, 1]);
  for (const [copy, source] of Object.entries(map)) {
    assert.equal(ONE_IS_EXACTLY_ONE.has(copy), ONE_IS_EXACTLY_ONE.has(source), `${copy} ← ${source}`);
    if (ONE_IS_EXACTLY_ONE.has(source)) assert.deepEqual(oneIntegers(copy), [1], `${copy} ← ${source}`);
  }
});

test('placeholder relaxation removes exactly one count only from eligible paired singulars', () => {
  assert.equal(typeof placeholdersMatch, 'function');
  const extract = text => text.match(/\{[^}]+\}/g) || [];
  for (const [locale, key, source, translation, paired, ok, relaxed] of [
    ['de_DE', 'items_one', '{count} item', 'Ein Artikel', true, true, true],
    ['de', 'items_one', '{count} item', 'Ein Artikel', true, true, true],
    ['es', 'items_one', '{count} item', 'Un artículo', true, true, true],
    ['nl', 'items_one', '{count} item', 'Een artikel', true, true, true],
    ['de_DE', 'items_one', '{count} {term}', 'Ein {term}', true, true, true],
    ['de_DE', 'items_one', '{count} {term}', 'Ein Artikel', true, false, false],
    ['fr_FR', 'items_one', '{count} item', 'Un article', true, false, false],
    ['pt_PT', 'items_one', '{count} item', 'Um artigo', true, false, false],
    ['pt', 'items_one', '{count} item', 'Um artigo', true, false, false],
    ['ru_RU', 'items_one', '{count} item', 'Item', true, false, false],
    ['en_US', 'items_one', '{count} item', 'One item', true, false, false],
    ['de_DE', 'items_one', '{n} item', 'Ein Artikel', true, false, false],
    ['de_DE', 'items_one', 'One item', '{count} Artikel', true, false, false],
    ['de_DE', 'items', '{count} item', 'Ein Artikel', true, false, false],
    ['de_DE', 'items_other', '{count} items', 'Artikel', true, false, false],
    ['de_DE', 'items_one', '{count} item', 'Ein Artikel', false, false, false],
    ['de_DE', 'items_one', '{count} {count}', '{count}', true, true, true],
    ['de_DE', 'items_one', '{count} {count}', 'Ein Artikel', true, false, false],
    ['de_DE', 'items_one', '{count} {term}', '{term} {count}', true, true, false],
  ]) {
    const sourceStrings = Object.freeze({ ...(paired ? { items_other: '{count} items' } : {}), [key]: 'Not the resolved source' });
    const result = placeholdersMatch({ locale, key, sourceText: source, sourceStrings, translation, extract });
    assert.deepEqual(result, { ok, relaxed, srcPH: extract(source).sort(), trnPH: extract(translation).sort() },
      JSON.stringify({ locale, key, source, translation, paired }));
  }
});

test('release gate relaxes singulars and errors on missing source placeholders in every project', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'one-form-gate-'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'source/php'), { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), 'dir');
    for (const file of ['check-completeness.js', 'plural-rules.js']) {
      fs.copyFileSync(path.join(__dirname, '../scripts', file), path.join(root, 'scripts', file));
    }
    write('locales.json', { de_DE: 'German' });
    const files = ['monorepo/core.json', 'woocommerce-pos/wp-admin-settings.json', 'woocommerce-pos-pro/wp-admin-store-edit.json'];
    for (const file of files) {
      const source = { items_one: '{count} {term}', items_other: '{count} {term}', bad_one: 'One item', bad_other: '{n} items' };
      write(`source/js/${file}`, source);
      write(`translations/js/de_DE/${file}`, { ...source, items_one: 'Ein {term}' });
    }
    const run = require('node:child_process').spawnSync(process.execPath,
      [path.join(root, 'scripts/check-completeness.js'), '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.errors, 3);
    for (const file of files) assert.ok(report.details.errors.some(message =>
      message.includes(`${file}:bad_one`) && message.includes('source') && message.includes('{n}')));
    assert.ok(!report.details.errors.some(message => message.includes(':items_one')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('flags customer-facing WooCommerce POS product names', () => {
  assert.deepEqual(findWcposNamingIssues('Please update WooCommerce POS Pro.'), [
    'Use "WCPOS Pro" instead of "WooCommerce POS Pro"',
  ]);
  assert.deepEqual(findWcposNamingIssues('WooCommerce POS API not found.'), [
    'Use "WCPOS" instead of "WooCommerce POS"',
  ]);
});

test('does not flag correct product names or technical identifiers', () => {
  assert.deepEqual(findWcposNamingIssues('Please update WCPOS Pro.'), []);
  assert.deepEqual(findWcposNamingIssues('woocommerce-pos'), []);
  assert.deepEqual(findWcposNamingIssues('wcposVersion'), []);
});

test('records grouped triage issue counts', () => {
  const summary = createTriageSummary();

  recordTriageIssue(summary, 'missing_js_keys', 'woocommerce-pos/wp-admin-settings.json', 17);
  recordTriageIssue(summary, 'missing_js_keys', 'woocommerce-pos/wp-admin-settings.json', 17);
  recordTriageIssue(summary, 'php_untranslated', 'woocommerce-pos.po', 212);
  recordTriageIssue(summary, 'naming_violation', 'woocommerce-pos-pro.po', 1);

  assert.equal(summary.missing_js_keys.get('woocommerce-pos/wp-admin-settings.json'), 34);
  assert.equal(summary.php_untranslated.get('woocommerce-pos.po'), 212);
  assert.equal(summary.naming_violation.get('woocommerce-pos-pro.po'), 1);
});


test('serializes triage summary as sorted plain objects for automation', () => {
  const summary = createTriageSummary();

  recordTriageIssue(summary, 'missing_js_keys', 'b.json', 2);
  recordTriageIssue(summary, 'missing_js_keys', 'a.json', 5);
  recordTriageIssue(summary, 'missing_js_keys', 'c.json', 1);

  assert.deepEqual(serializeTriageSummary(summary, { limit: 2 }), {
    missing_js_keys: [
      { key: 'a.json', count: 5 },
      { key: 'b.json', count: 2 },
    ],
    stale_js_keys: [],
    php_untranslated: [],
    naming_violation: [],
    php_plural_metadata: [],
  });
});

test('parses changed-since and GitHub annotation CLI options', () => {
  assert.deepEqual(parseCliOptions(['--json', '--changed-since', 'origin/main', '--github-annotations']), {
    json: true,
    changedSince: 'origin/main',
    githubAnnotations: true,
  });

  assert.deepEqual(parseCliOptions(['--changed-since=upstream/main']), {
    json: false,
    changedSince: 'upstream/main',
    githubAnnotations: false,
  });

  assert.throws(() => parseCliOptions(['--changed-since']), /--changed-since/);

  assert.throws(() => parseCliOptions(['--changed-since', '--json']), /--changed-since/);

  assert.throws(() => parseCliOptions(['--changed-since=']), /--changed-since/);

  assert.deepEqual(parseCliOptions([]), {
    json: false,
    changedSince: null,
    githubAnnotations: false,
  });
});

test('parses renamed files from git name-status output', () => {
  assert.deepEqual(parseGitChangedFiles([
    'M\ttranslations/js/de_DE/woocommerce-pos/common.json',
    'R100\ttranslations/js/fr_FR/woocommerce-pos/old.json\ttranslations/js/fr_FR/woocommerce-pos/new.json',
    'R087\ttranslations/php/es_ES/woocommerce-pos-es_ES.po\ttranslations/php/es_ES/woocommerce-pos-pro-es_ES.po',
    '',
  ].join('\n')), [
    'translations/js/de_DE/woocommerce-pos/common.json',
    'translations/js/fr_FR/woocommerce-pos/old.json',
    'translations/js/fr_FR/woocommerce-pos/new.json',
    'translations/php/es_ES/woocommerce-pos-es_ES.po',
    'translations/php/es_ES/woocommerce-pos-pro-es_ES.po',
  ]);
});

test('builds changed scope with separate JS, PHP, and script flags', () => {
  const scope = createChangedScope('origin/main', [
    'source/js/woocommerce-pos/common.json',
    'source/php/woocommerce-pos.pot',
    'scripts/check-completeness.js',
    'translations/js/de_DE/woocommerce-pos/common.json',
    'translations/php/es_ES/woocommerce-pos-es_ES.po',
    'translations/php/es_ES/woocommerce-pos-es_ES.l10n.php',
  ]);

  assert.equal(scope.baseRef, 'origin/main');
  assert.equal(scope.jsSourceChanged, true);
  assert.equal(scope.phpSourceChanged, true);
  assert.equal(scope.checkerChanged, true);
  assert.deepEqual([...scope.jsTranslationFiles], [
    'translations/js/de_DE/woocommerce-pos/common.json',
  ]);
  assert.deepEqual([...scope.phpPoFiles], [
    'translations/php/es_ES/woocommerce-pos-es_ES.po',
  ]);
  assert.deepEqual([...scope.phpL10nFiles], [
    'translations/php/es_ES/woocommerce-pos-es_ES.l10n.php',
  ]);
});

test('tracks checker-only changes without marking translation sources changed', () => {
  const scope = createChangedScope('origin/main', [
    'scripts/check-completeness.js',
  ]);

  assert.equal(scope.checkerChanged, true);
  assert.equal(scope.jsSourceChanged, false);
  assert.equal(scope.phpSourceChanged, false);
  assert.equal(scope.jsTranslationFiles.size, 0);
  assert.equal(scope.phpPoFiles.size, 0);
  assert.equal(scope.phpL10nFiles.size, 0);
});

test('locale plural expected keys match current Intl plural categories for app locales', () => {
  const { expectedKeysForLocale } = require('../scripts/plural-rules.js');
  const sourceKeys = [
    'logs.entries_count_one',
    'logs.entries_count_other',
  ];

  for (const locale of ['ca_ES', 'es', 'es_AR', 'es_ES', 'es_MX', 'fr', 'fr_CA', 'fr_FR', 'it_IT', 'pt', 'pt_BR', 'pt_PT']) {
    assert.deepEqual([...expectedKeysForLocale(sourceKeys, locale)].sort(), [
      'logs.entries_count_many',
      'logs.entries_count_one',
      'logs.entries_count_other',
    ]);
  }

  assert.deepEqual([...expectedKeysForLocale(sourceKeys, 'zh_TW')].sort(), [
    'logs.entries_count_other',
  ]);
});

test('generated plural forms use a non-singular source fallback', () => {
  assert.equal(sourceTextForTranslationKey({
    'items_one': '1 item',
    'items_other': '{count} items',
  }, 'items_many'), '{count} items');

  assert.equal(sourceTextForTranslationKey({
    'items_one': '1 item',
    'items_many': '{count} items',
  }, 'items_other'), '{count} items');
});

function pluralShapeMismatches(pluralBases, translations, expectedSuffixes, allSuffixes) {
  const mismatches = [];
  for (const base of pluralBases) {
    const actual = allSuffixes.filter(suffix => `${base}_${suffix}` in translations);
    if (actual.length > 0 && (
      actual.length !== expectedSuffixes.length ||
      actual.some((suffix, index) => suffix !== expectedSuffixes[index])
    )) {
      mismatches.push({ base, actual });
    }
  }
  return mismatches;
}

test('rolling monorepo translations retain locale-specific plural forms', () => {
  const locales = [
    'bg_BG', 'ca_ES', 'da', 'de_DE', 'el', 'es', 'es_AR', 'es_ES', 'es_MX',
    'fr', 'fr_CA', 'fr_FR', 'hu_HU', 'id_ID', 'is_IS', 'mk_MK', 'ms_MY',
    'nb_NO', 'nl', 'nl_BE', 'nl_NL', 'pt_BR', 'pt_PT', 'sv_SE', 'th', 'vi',
  ];
  const { ALL_SUFFIXES, getPluralSuffixes } = require('../scripts/plural-rules.js');
  // Take the plural bases from the source file so this test tracks the
  // strings that actually exist. A hardcoded key list went stale on
  // 2026-08-23 when `health.database.other_stores` left the source, and the
  // test then failed for a key no locale is supposed to have.
  const source = require('../source/js/monorepo/core.json');
  const pluralBases = [...pluralBasesOf(Object.keys(source))].sort();
  assert.ok(pluralBases.length > 0, 'expected at least one plural base in the source');

  for (const locale of locales) {
    const translations = require(`../translations/js/${locale}/monorepo/core.json`);
    const expectedSuffixes = getPluralSuffixes(locale);

    // Untranslated bases are left to the completeness check.
    assert.deepEqual(pluralShapeMismatches(pluralBases, translations, expectedSuffixes, ALL_SUFFIXES), [], `${locale}: plural shape`);
  }
});

test('a lone _other key is a plain key, not a plural base', () => {
  const sourceKeys = ['items_one', 'items_other', 'kind_cash', 'kind_other'];
  assert.deepEqual(pluralBasesOf(sourceKeys), new Set(['items']));
  assert.deepEqual([...expectedKeysForLocale(sourceKeys, 'bg_BG')].sort(), [
    'items_one', 'items_other', 'kind_cash', 'kind_other',
  ]);
  assert.deepEqual([...expectedKeysForLocale(sourceKeys, 'ja')].sort(), [
    'items_other', 'kind_cash', 'kind_other',
  ]);
  const arabicKeys = expectedKeysForLocale(sourceKeys, 'ar');
  for (const key of ['items_zero', 'items_few', 'items_many']) assert.ok(arabicKeys.has(key));
  for (const key of ['kind_zero', 'kind_one', 'kind_two', 'kind_few', 'kind_many']) assert.ok(!arabicKeys.has(key));
});

test('the pair rule and the one-is-exactly-one relaxation hold together', () => {
  const extract = text => text.match(/\{[^}]+\}/g) || [];
  const sourceStrings = Object.freeze({
    items_one: '{count} item',
    items_other: '{count} items',
    badge_one: '{count} badge',
    kind_cash: 'Cash',
    kind_other: 'Other',
  });

  assert.deepEqual(pluralBasesOf(Object.keys(sourceStrings)), new Set(['items']));
  assert.deepEqual([...expectedKeysForLocale(Object.keys(sourceStrings), 'de_DE')].sort(), [
    'badge_one', 'items_one', 'items_other', 'kind_cash', 'kind_other',
  ]);
  assert.deepEqual(placeholdersMatch({
    locale: 'de_DE', key: 'items_one', sourceText: '{count} item', translation: 'Ein Artikel',
    sourceStrings, extract,
  }), { ok: true, relaxed: true, srcPH: ['{count}'], trnPH: [] });
  assert.deepEqual(placeholdersMatch({
    locale: 'de_DE', key: 'badge_one', sourceText: '{count} badge', translation: 'Ein Abzeichen',
    sourceStrings, extract,
  }), { ok: false, relaxed: false, srcPH: ['{count}'], trnPH: [] });
  assert.deepEqual(placeholdersMatch({
    locale: 'de_DE', key: 'kind_other', sourceText: 'Other', translation: 'Andere',
    sourceStrings, extract,
  }), { ok: true, relaxed: false, srcPH: [], trnPH: [] });
  assert.deepEqual(placeholdersMatch({
    locale: 'fr_FR', key: 'items_one', sourceText: '{count} item', translation: 'Un article',
    sourceStrings, extract,
  }), { ok: false, relaxed: false, srcPH: ['{count}'], trnPH: [] });
});

test('plural shape check skips untranslated bases but flags wrong shapes', () => {
  const base = 'items';
  const expectedSuffixes = ['one', 'other'];
  const allSuffixes = ['zero', 'one', 'two', 'few', 'many', 'other'];

  assert.deepEqual(pluralShapeMismatches([base], {}, expectedSuffixes, allSuffixes), []);
  assert.deepEqual(pluralShapeMismatches([base], {
    items_one: '1 item',
    items_other: '{count} items',
  }, expectedSuffixes, allSuffixes), []);
  assert.deepEqual(pluralShapeMismatches([base], {
    items_other: '{count} items',
  }, expectedSuffixes, allSuffixes), [{ base, actual: ['other'] }]);
  assert.deepEqual(pluralShapeMismatches([base], {
    items_one: '1 item',
    items_many: '{count} items',
    items_other: '{count} items',
  }, expectedSuffixes, allSuffixes), [{ base, actual: ['one', 'many', 'other'] }]);
});

test('checks matching PHP PO file when l10n artifact changes', () => {
  const scope = createChangedScope('origin/main', [
    'translations/php/es_ES/woocommerce-pos-es_ES.l10n.php',
  ]);
  const poPath = path.join(__dirname, '..', 'translations/php/es_ES/woocommerce-pos-es_ES.po');
  const unrelatedPoPath = path.join(__dirname, '..', 'translations/php/fr_FR/woocommerce-pos-fr_FR.po');

  assert.equal(shouldCheckPhpPoFile(poPath, scope), true);
  assert.equal(shouldCheckPhpPoFile(unrelatedPoPath, scope), false);
});

test('parses PHP Plural-Forms headers for gettext slot validation', () => {
  assert.deepEqual(parsePluralFormsHeader({
    'plural-forms': 'nplurals=3; plural=n%10==1 ? 0 : 2;',
  }), {
    nplurals: 3,
    header: 'nplurals=3; plural=n%10==1 ? 0 : 2;',
  });

  assert.equal(parsePluralFormsHeader({}), null);
  assert.equal(parsePluralFormsHeader({ 'plural-forms': 'plural=n != 1;' }), null);
});

test('detects plural-forms metadata in l10n.php artifacts', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-l10n-'));
  const withHeader = path.join(tempDir, 'with.l10n.php');
  const withoutHeader = path.join(tempDir, 'without.l10n.php');

  fs.writeFileSync(withHeader, "<?php return array('plural-forms' => 'nplurals=2; plural=n != 1;', 'messages' => array());");
  fs.writeFileSync(withoutHeader, "<?php return array('messages' => array());");

  assert.equal(l10nHasPluralFormsHeader(withHeader), true);
  assert.equal(l10nHasPluralFormsHeader(withoutHeader), false);
  assert.equal(l10nHasPluralFormsHeader(path.join(tempDir, 'missing.l10n.php')), false);
});

test('PHP artifact generator writes plural metadata into l10n.php', () => {
  const { generateL10nPhp } = require('../scripts/generate-php-files.js');
  const l10n = generateL10nPhp({
    headers: {
      'plural-forms': 'nplurals=2; plural=n != 1;',
      language: 'de',
    },
    translations: {
      '': {
        'One order': {
          msgstr: ['Eine Bestellung', '%s Bestellungen'],
        },
      },
    },
  });

  assert.match(l10n, /'plural-forms' => 'nplurals=2; plural=n != 1;'/);
  assert.match(l10n, /'language' => 'de'/);
  assert.match(l10n, /Eine Bestellung/);
  assert.match(l10n, /%s Bestellungen/);
  assert.match(l10n, /\\x00/);
});
