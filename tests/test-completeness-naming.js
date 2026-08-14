#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');

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

test('rolling monorepo translations retain locale-specific plural forms', () => {
  const locales = [
    'bg_BG', 'ca_ES', 'da', 'de_DE', 'el', 'es', 'es_AR', 'es_ES', 'es_MX',
    'fr', 'fr_CA', 'fr_FR', 'hu_HU', 'id_ID', 'is_IS', 'mk_MK', 'ms_MY',
    'nb_NO', 'nl', 'nl_BE', 'nl_NL', 'pt_BR', 'pt_PT', 'sv_SE', 'th', 'vi',
  ];
  const { ALL_SUFFIXES, getPluralSuffixes } = require('../scripts/plural-rules.js');

  for (const locale of locales) {
    const translations = require(`../translations/js/${locale}/monorepo/core.json`);
    const expectedSuffixes = getPluralSuffixes(locale);

    for (const base of ['health.database.attention', 'health.database.other_stores']) {
      const actualSuffixes = ALL_SUFFIXES.filter(suffix => `${base}_${suffix}` in translations);
      assert.deepEqual(actualSuffixes, expectedSuffixes, `${locale}: ${base}`);
    }
  }
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
