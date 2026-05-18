#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  buildPhpContextPackets,
  matchConcepts,
  normalizeSourceTerm,
} = require('../scripts/translation-context-packets');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  ${error.message}`);
    failed++;
  }
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-context-'));
  fs.mkdirSync(path.join(dir, 'source/php'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'translations/php/da_DK'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'source/php/woocommerce-pos.pot'), `msgid ""
msgstr ""
"Project-Id-Version: WooCommerce POS\\n"

#. translators: Label for a receipt data field in the template editor.
#. translators: Standalone label used in printed receipt templates.
#: includes/Services/Receipt_Data_Schema.php:853
#: includes/Services/Receipt_I18n_Labels.php:169
#: templates/receipt.php:360
msgid "Tendered"
msgstr ""

#: includes/Services/Receipt_Data_Schema.php:852
msgid "Amount"
msgstr ""

#: includes/Services/Receipt_Data_Schema.php:854
msgid "Change"
msgstr ""

#: includes/Gateways/Cash.php:48
msgid "Amount Tendered"
msgstr ""

#: includes/Gateways/Cash.php:52
msgid "Tendered amount must be zero or greater."
msgstr ""
`);

  fs.writeFileSync(path.join(dir, 'translations/php/da_DK/woocommerce-pos-da_DK.po'), `msgid ""
msgstr ""
"Project-Id-Version: WooCommerce POS\\n"
"Language: da_DK\\n"

#: includes/Gateways/Cash.php:48
msgid "Amount Tendered"
msgstr "Indbetalt beløb"

#: includes/Gateways/Cash.php:52
msgid "Tendered amount must be zero or greater."
msgstr "Modtaget beløb skal være nul eller højere."
`);

  return dir;
}

test('normalizes source terms case-insensitively with stable whitespace', () => {
  assert.strictEqual(normalizeSourceTerm('  Tendered\nAmount  '), 'tendered amount');
});

test('matches glossary concepts by full source term, not arbitrary substring', () => {
  const tendered = matchConcepts('Tendered');
  assert.ok(tendered.some(concept => concept.id === 'amount_tendered'));

  const contender = matchConcepts('Contender');
  assert.ok(!contender.some(concept => concept.id === 'amount_tendered'));
});

test('builds PHP context packet with translator comments and source references', () => {
  const root = makeTempRepo();
  const packets = buildPhpContextPackets({ rootDir: root, locale: 'da_DK', domain: 'woocommerce-pos' });
  const tendered = packets.entries.find(packet => packet.entry.msgid === 'Tendered');

  assert.ok(tendered, 'expected Tendered packet');
  assert.deepStrictEqual(tendered.entry.translator_comments, [
    'Label for a receipt data field in the template editor.',
    'Standalone label used in printed receipt templates.',
  ]);
  assert.deepStrictEqual(tendered.entry.references, [
    'includes/Services/Receipt_Data_Schema.php:853',
    'includes/Services/Receipt_I18n_Labels.php:169',
    'templates/receipt.php:360',
  ]);
  assert.ok(tendered.source_usage.nearby_source_strings.includes('Amount'));
  assert.ok(tendered.source_usage.nearby_source_strings.includes('Change'));
});

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, ${failed} failed`);
