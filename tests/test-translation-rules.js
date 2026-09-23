#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  normalizeWcposProductNames,
  extractPlaceholders,
  extractMarkupTags,
  checkTranslation,
  checkEnglishSource,
} = require('../scripts/translation-rules');
const { scenarios } = require('./fixtures/translate-evals.json');

for (const scenario of scenarios) {
  const counts = { errors: 0, warnings: 0 };
  for (const [key, source] of Object.entries(scenario.source)) {
    const result = checkTranslation({
      locale: scenario.locale, source, translation: scenario.translation[key],
    });
    counts.errors += result.errors.length;
    counts.warnings += scenario.id === 'english-source-regression'
      ? checkEnglishSource(source, 'american').length : result.warnings.length;
    assert.ok([...result.errors, ...result.warnings].every(message => typeof message === 'string'));
  }
  assert.deepEqual(counts, scenario.expect, scenario.id);
}

assert.deepEqual(extractPlaceholders('{count} of %1$s, %2$d%% {{x}}'),
  ['%%', '%1$s', '%2$d', '{count}', '{{x}}']);
assert.deepEqual(extractPlaceholders('50% off'), []);
assert.deepEqual(extractPlaceholders('%s %d %f %u %% %1 %12 %12$s %2$d'),
  ['%%', '%1', '%12', '%12$s', '%2$d', '%d', '%f', '%s', '%u']);
assert.deepEqual(extractPlaceholders('%x % S %12$x %12$'), []);
assert.deepEqual(extractPlaceholders('{x} {x} {{x}}'), ['{x}', '{x}', '{{x}}']);

for (const [source, translation, errors] of [
  ['%1$s %2$d', '%2$d %1$s', 0],
  ['{x} {x}', '{x}', 1],
  ['{x}', '{{x}}', 1],
  ['%s', '%d', 1],
  ['%1 %12', '%12 %1', 0],
  ['text', 'text %s', 1],
  ['%%', '%', 1],
  ['text', '', 1],
  ['text', ' \n\t', 1],
  ['WCPOS', 'WooCommerce POS', 1],
  ['WCPOS Pro', 'WooCommerce POS Pro', 1],
  ['WCPOS Pro', 'WCPOS Pro', 0],
]) {
  assert.equal(checkTranslation({ locale: 'fr_FR', source, translation }).errors.length,
    errors, JSON.stringify({ source, translation }));
}

assert.deepEqual(extractMarkupTags('<strong>x</strong><a href="%s">y</a><br/>'),
  ['/a', '/strong', 'a', 'br', 'strong']);
assert.deepEqual(extractMarkupTags('<a title="x > y">x</a>'), ['/a', 'a']);
const attributeResult = checkTranslation({
  locale: 'fr_FR', source: '<a href="%s">x</a>', translation: '<a>x</a>',
});
assert.equal(attributeResult.errors.length, 1);
assert.match(attributeResult.errors[0], /placeholder/i);
for (const [source, translation] of [
  ['<strong>x</strong>', 'x'],
  ['<strong>x</strong>', '<strong>x'],
  ['<br/><br/>', '<br/>'],
]) {
  const result = checkTranslation({ locale: 'fr_FR', source, translation });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /markup/i);
}

for (const [locale, source, translation, warnings] of [
  ['fr_FR', 'v2.0.1', 'v2.0.1', 0],
  ['fr_FR', '0.25 kg', '0,25 kg', 0],
  ['fr_FR', 'weight', '0.25 kg', 0],
  ['fr_BE', '0.25 kg', '0.25 kg', 1],
  ['es_MX', '0.25 kg', '0.25 kg', 0],
  ['fr_FR', 'e.g.', 'eg:', 1],
  ['de_CH', 'CASHIER', 'cashier', 1],
  ['de_DE', 'cashiers', 'cashiers', 0],
  ['de_DE', 'Cashier', 'KASSIERERIN', 0],
  ['de_AT', 'Gateway', 'Gateway', 0],
  ['zz_ZZ', 'Cashier 0.25', 'Cashier 0.25', 0],
]) {
  const result = checkTranslation({ locale, source, translation });
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, warnings, JSON.stringify({ locale, source, translation }));
}
assert.deepEqual(checkTranslation({ locale: 'de_DE', source: 'Cashier', translation: 'Cashier' }).warnings,
  ['"Cashier" should be translated as "Kassierer" for de_DE']);

for (const [source, translation, missingTerms] of [
  ['Open POS', 'POS öffnen', []],
  ['Open POS', 'Kasse öffnen', ['POS']],
  ['Upgrade to WCPOS Pro', 'Auf WCPOS Pro upgraden', []],
  ['Upgrade to WCPOS Pro', 'Auf die Pro-Version upgraden', ['WCPOS Pro']],
  ['WooCommerce POS', 'WCPOS', []],
  ['WooCommerce POS Pro', 'WCPOS Pro', []],
  ['WCPOS Pro and WCPOS Pro', 'Pro-Version', ['WCPOS Pro']],
  ['WCPOS Pro and WCPOS', 'Pro-Version', ['WCPOS Pro', 'WCPOS']],
  ['WCPOS Pro and WCPOS', 'WCPOS', ['WCPOS Pro']],
  ['WooCommerce and WordPress', 'Shop und Website', ['WooCommerce', 'WordPress']],
  ['WooCommerce and WordPress', 'WooCommerce und WordPress', []],
  ['Open POS', 'pos öffnen', ['POS']],
  ['Open pos', 'Kasse öffnen', []],
  ['WCPOSia POSitive MyWordPress WooCommerceX', 'Text', []],
  ['WCPOS', 'WCPOSia', ['WCPOS']],
  ['WCPOS Pro', 'WCPOS-Pro-Lizenz', ['WCPOS Pro']],
]) {
  const result = checkTranslation({ locale: 'de', source, translation });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, missingTerms.map(term => `"${term}" should remain untranslated`),
    JSON.stringify({ source, translation }));
}

assert.deepEqual(checkEnglishSource('Customise', 'american'),
  ['Spelling: use "customize" not the matched form (American English uses -ize)']);
assert.equal(checkEnglishSource('Customize color', 'british').length, 2);
assert.equal(checkEnglishSource('Thank You eg:', 'american').length, 2);
assert.equal(checkEnglishSource('Thank you e.g. customize', 'american').length, 0);
assert.equal(checkEnglishSource('customiser', 'american').length, 0);
assert.equal(normalizeWcposProductNames('Upgrade to WooCommerce POS Pro'), 'Upgrade to WCPOS Pro');
assert.equal(normalizeWcposProductNames('WooCommerce POS and WooCommerce POS Pro'), 'WCPOS and WCPOS Pro');
assert.equal(normalizeWcposProductNames('xWooCommerce POS WooCommerce POSitive'),
  'xWooCommerce POS WooCommerce POSitive');

console.log(`${scenarios.length} fixture scenarios and direct translation rule assertions passed`);
