#!/usr/bin/env node

const assert = require('node:assert/strict');

const {
  findWcposNamingIssues,
  createTriageSummary,
  recordTriageIssue,
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
