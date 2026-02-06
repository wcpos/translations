#!/usr/bin/env node

/**
 * Test the translation workflow with a small sample.
 *
 * Tests:
 * - Translation API integration works
 * - Output format is correct
 * - Placeholders are preserved
 * - QA structural checks pass
 *
 * Usage:
 *   OPENAI_API_KEY=... node tests/test-translation.js
 *   node tests/test-translation.js --dry-run  (structural tests only)
 */

const OpenAI = require('openai').default;
const fs = require('fs').promises;
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const LOCALE = 'de_DE'; // Test with German

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn, requiresApi = false) {
  if (requiresApi && DRY_RUN) {
    console.log(`  ○ ${name} (skipped - dry run)`);
    skipped++;
    return Promise.resolve();
  }

  return fn()
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((error) => {
      console.log(`  ✗ ${name}`);
      console.log(`    ${error.message}`);
      failed++;
    });
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n    Expected: ${JSON.stringify(expected)}\n    Actual: ${JSON.stringify(actual)}`);
  }
}

function assertMatch(str, regex, message) {
  if (!regex.test(str)) {
    throw new Error(`${message}\n    String "${str}" does not match ${regex}`);
  }
}

// Sample source strings for testing
const SAMPLE_STRINGS = {
  'Welcome': { string: 'Welcome', files: ['test.tsx'] },
  'Hello {name}': { string: 'Hello {name}', files: ['test.tsx'] },
  'You have {count} items in your cart': { string: 'You have {count} items in your cart', files: ['test.tsx'] },
  'Save': { string: 'Save', files: ['test.tsx'] },
  'Cancel': { string: 'Cancel', files: ['test.tsx'] },
  'Open_button': { string: 'Open', context: 'button', files: ['test.tsx'] },
};

async function translateBatch(strings, locale) {
  const openai = new OpenAI();
  const input = {};
  for (const entry of Object.values(strings)) {
    input[entry.string] = entry.context || '';
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    temperature: 0.3,
    messages: [
      { role: 'system', content: 'You are a professional translator for POS software UI.' },
      {
        role: 'user',
        content: `Translate the following UI strings to German (Germany). The keys are the English source strings. The values are optional context hints.

Return a JSON object where keys are the ORIGINAL English strings and values are the translations.

${JSON.stringify(input, null, 2)}`,
      },
    ],
  });

  let text = response.choices[0].message.content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  return JSON.parse(text);
}

function checkPlaceholders(source, translated) {
  const placeholderRegex = /\{[^}]+\}/g;
  const sourcePlaceholders = (source.match(placeholderRegex) || []).sort();
  const translatedPlaceholders = (translated.match(placeholderRegex) || []).sort();
  return JSON.stringify(sourcePlaceholders) === JSON.stringify(translatedPlaceholders);
}

async function main() {
  console.log('Testing translation workflow\n');

  if (!DRY_RUN && !process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY required (or use --dry-run for structural tests only)');
    process.exit(1);
  }

  let translations = {};

  // API Integration Tests
  console.log('Testing API integration...');

  await test(
    'can translate sample strings',
    async () => {
      translations = await translateBatch(SAMPLE_STRINGS, LOCALE);
      if (Object.keys(translations).length === 0) {
        throw new Error('No translations returned');
      }
    },
    true
  );

  await test(
    'all source strings have translations',
    async () => {
      for (const entry of Object.values(SAMPLE_STRINGS)) {
        if (!translations[entry.string]) {
          throw new Error(`Missing translation for: ${entry.string}`);
        }
      }
    },
    true
  );

  await test(
    'translations are not empty',
    async () => {
      for (const [source, translated] of Object.entries(translations)) {
        if (!translated || translated.trim() === '') {
          throw new Error(`Empty translation for: ${source}`);
        }
      }
    },
    true
  );

  // Structural Tests
  console.log('\nTesting structural integrity...');

  await test(
    'placeholders are preserved in translations',
    async () => {
      // For dry run, use mock translations
      const testTranslations = DRY_RUN
        ? {
            'Hello {name}': 'Hallo {name}',
            'You have {count} items in your cart': 'Sie haben {count} Artikel in Ihrem Warenkorb',
          }
        : translations;

      for (const [source, translated] of Object.entries(testTranslations)) {
        if (!checkPlaceholders(source, translated)) {
          throw new Error(`Placeholder mismatch in: ${source} -> ${translated}`);
        }
      }
    },
    false
  );

  await test(
    'translation output format is valid JSON structure',
    async () => {
      const testTranslations = DRY_RUN
        ? { Welcome: 'Willkommen', Save: 'Speichern' }
        : translations;

      // Check it's an object with string values
      if (typeof testTranslations !== 'object' || testTranslations === null) {
        throw new Error('Translations should be an object');
      }
      for (const [key, value] of Object.entries(testTranslations)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          throw new Error('Keys and values should be strings');
        }
      }
    },
    false
  );

  // QA Tests
  console.log('\nTesting QA checks...');

  await test(
    'structural QA detects placeholder mismatches',
    async () => {
      const badTranslation = { 'Hello {name}': 'Hallo' }; // Missing placeholder
      const hasPlaceholderIssue = !checkPlaceholders('Hello {name}', badTranslation['Hello {name}']);
      if (!hasPlaceholderIssue) {
        throw new Error('Should detect placeholder mismatch');
      }
    },
    false
  );

  await test(
    'structural QA passes valid translations',
    async () => {
      const goodTranslation = { 'Hello {name}': 'Hallo {name}' };
      const isValid = checkPlaceholders('Hello {name}', goodTranslation['Hello {name}']);
      if (!isValid) {
        throw new Error('Should pass valid translation');
      }
    },
    false
  );

  // New Format Tests
  console.log('\nTesting new source format (semantic keys)...');

  const SAMPLE_STRINGS_NEW = {
    'common.welcome': 'Welcome',
    'common.hello_name': 'Hello {name}',
    'common.cart_items': 'You have {count} items in your cart',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.open': 'Open',
  };

  await test(
    'new format: placeholders preserved with semantic keys',
    async () => {
      const mockTranslations = {
        'common.hello_name': 'Hallo {name}',
        'common.cart_items': 'Sie haben {count} Artikel in Ihrem Warenkorb',
      };

      for (const [key, translated] of Object.entries(mockTranslations)) {
        const english = SAMPLE_STRINGS_NEW[key];
        if (!checkPlaceholders(english, translated)) {
          throw new Error(`Placeholder mismatch in: ${key} (${english}) -> ${translated}`);
        }
      }
    },
    false
  );

  await test(
    'new format: detects placeholder mismatch with semantic keys',
    async () => {
      const badTranslation = { 'common.hello_name': 'Hallo' }; // Missing {name}
      const english = SAMPLE_STRINGS_NEW['common.hello_name'];
      const hasIssue = !checkPlaceholders(english, badTranslation['common.hello_name']);
      if (!hasIssue) {
        throw new Error('Should detect placeholder mismatch in semantic key format');
      }
    },
    false
  );

  // Output results
  if (!DRY_RUN && Object.keys(translations).length > 0) {
    console.log('\nSample translations received:');
    for (const [source, translated] of Object.entries(translations)) {
      console.log(`  "${source}" → "${translated}"`);
    }
  }

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('='.repeat(40));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
