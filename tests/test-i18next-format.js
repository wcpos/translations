#!/usr/bin/env node

/**
 * Test that translation output format is compatible with react-i18next.
 *
 * Tests:
 * 1. JSON structure is valid for i18next resource bundle
 * 2. Placeholders use i18next interpolation format
 * 3. Keys match source strings (natural language keys approach)
 * 4. No nested objects (flat structure)
 * 5. Plural patterns identified and documented
 */

const fs = require('fs');
const path = require('path');

const TRANSLATIONS_DIR = path.resolve(__dirname, '../translations/js');
const SOURCE_DIR = path.resolve(__dirname, '../source/js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ─── Format Validation ─────────────────────────────────────────────────────────

console.log('Testing i18next format compatibility\n');

console.log('Testing JSON structure...');

// Find a sample translation file (handles both old flat and new nested structure)
const locales = fs.readdirSync(TRANSLATIONS_DIR).filter(f =>
  fs.statSync(path.join(TRANSLATIONS_DIR, f)).isDirectory()
);

function findTranslationFile(localeDir, filename) {
  // Try new nested structure first: {locale}/monorepo/core.json
  const nestedPath = path.join(localeDir, 'monorepo', filename);
  if (fs.existsSync(nestedPath)) return nestedPath;

  // Fall back to old flat structure: {locale}/core.json
  const flatPath = path.join(localeDir, filename);
  if (fs.existsSync(flatPath)) return flatPath;

  return null;
}

if (locales.length === 0) {
  console.log('  ○ no translation files to test (skipped)');
} else {
  const sampleLocale = locales[0];
  const sampleFile = findTranslationFile(path.join(TRANSLATIONS_DIR, sampleLocale), 'core.json');

  if (sampleFile) {
    const translations = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));

    test('translation file is valid JSON object', () => {
      assert(typeof translations === 'object', 'must be object');
      assert(!Array.isArray(translations), 'must not be array');
    });

    test('translations have flat structure (no nested objects)', () => {
      for (const [key, value] of Object.entries(translations)) {
        assert(
          typeof value === 'string',
          `key "${key}" has non-string value: ${typeof value}`
        );
      }
    });

    test('keys are natural language strings (source text)', () => {
      // i18next with natural language keys uses the source string as the key
      const keys = Object.keys(translations);
      const hasNaturalKeys = keys.some(k => k.includes(' ') || k.length > 20);
      assert(hasNaturalKeys, 'expected natural language keys (phrases)');
    });

    test('translations are non-empty strings', () => {
      for (const [key, value] of Object.entries(translations)) {
        assert(value.length > 0, `key "${key}" has empty translation`);
      }
    });
  }
}

// ─── Placeholder Format ────────────────────────────────────────────────────────

console.log('\nTesting placeholder format...');

// i18next uses {{variable}} by default, but can be configured for {variable}
// Our format uses {variable} which requires interpolation config:
// { interpolation: { prefix: '{', suffix: '}' } }

if (locales.length > 0) {
  const sampleLocale = locales[0];
  const sampleFile = findTranslationFile(path.join(TRANSLATIONS_DIR, sampleLocale), 'core.json');

  if (sampleFile) {
    const translations = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));

    test('placeholders use {variable} format', () => {
      const withPlaceholders = Object.entries(translations).filter(([k]) =>
        k.includes('{') && k.includes('}')
      );

      for (const [key, value] of withPlaceholders) {
        // Extract placeholder names from key
        const keyPlaceholders = [...key.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
        const valuePlaceholders = [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

        // All source placeholders must appear in translation
        for (const p of keyPlaceholders) {
          assert(
            valuePlaceholders.includes(p),
            `placeholder {${p}} missing in translation of "${key.substring(0, 40)}..."`
          );
        }
      }
    });

    test('no double-brace {{variable}} format detected', () => {
      const doublebraceCount = Object.values(translations).filter(v =>
        v.includes('{{') && v.includes('}}')
      ).length;
      // Allow some, but flag if many (might indicate wrong format)
      assert(
        doublebraceCount < Object.keys(translations).length * 0.1,
        `${doublebraceCount} translations use {{}} format - verify interpolation config`
      );
    });
  }
}

// ─── Source/Translation Key Matching ───────────────────────────────────────────

console.log('\nTesting source/translation key alignment...');

const sourceFiles = fs.readdirSync(SOURCE_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => path.join(SOURCE_DIR, f));

// Also check monorepo subdirectory
const monorepoSourceDir = path.join(SOURCE_DIR, 'monorepo');
if (fs.existsSync(monorepoSourceDir)) {
  const monorepoFiles = fs.readdirSync(monorepoSourceDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(monorepoSourceDir, f));
  sourceFiles.push(...monorepoFiles);
}

if (sourceFiles.length > 0 && locales.length > 0) {
  const sourceFile = sourceFiles.find(f => f.includes('core.json'));

  if (sourceFile) {
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    const sourceKeys = new Set(Object.keys(source).map(k => source[k]?.string || k));

    const sampleLocale = locales[0];
    const translationFile = findTranslationFile(path.join(TRANSLATIONS_DIR, sampleLocale), 'core.json');

    if (translationFile) {
      const translations = JSON.parse(fs.readFileSync(translationFile, 'utf8'));
      const translationKeys = new Set(Object.keys(translations));

      test('translation keys match source strings', () => {
        const mismatched = [];
        for (const key of translationKeys) {
          if (!sourceKeys.has(key)) {
            mismatched.push(key);
          }
        }
        // Allow some orphaned translations (from previous versions)
        assert(
          mismatched.length < translationKeys.size * 0.1,
          `${mismatched.length} translation keys don't match source:\n    ${mismatched.slice(0, 3).join('\n    ')}...`
        );
      });
    }
  }
}

// ─── Plural Patterns Analysis ──────────────────────────────────────────────────

console.log('\nAnalyzing plural patterns...');

if (sourceFiles.length > 0) {
  const sourceFile = sourceFiles.find(f => f.includes('core.json'));

  if (sourceFile) {
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    const strings = Object.values(source).map(v => v?.string || '').filter(Boolean);

    // Find potential plural pairs
    const singularPatterns = strings.filter(s => /^1 [a-z]/i.test(s));
    const pluralPatterns = strings.filter(s => /\{count\}|\{n\}|\{num\}/i.test(s));

    test('plural patterns documented', () => {
      console.log(`    Found ${singularPatterns.length} singular patterns (starting with "1 ")`);
      console.log(`    Found ${pluralPatterns.length} patterns with count placeholder`);

      if (singularPatterns.length > 0) {
        console.log('\n    Singular patterns:');
        singularPatterns.slice(0, 5).forEach(s => console.log(`      - "${s}"`));
      }

      if (pluralPatterns.length > 0) {
        console.log('\n    Plural patterns with {count}:');
        pluralPatterns.slice(0, 5).forEach(s => console.log(`      - "${s}"`));
      }

      // This test always passes - it's informational
      assert(true, '');
    });
  }
}

// ─── i18next Configuration Recommendation ──────────────────────────────────────

console.log('\nRecommended i18next configuration...');

test('configuration documented for {variable} interpolation', () => {
  const config = `
  i18next.init({
    interpolation: {
      prefix: '{',
      suffix: '}',
      escapeValue: false, // React already escapes
    },
    // Natural language keys - use source string as key
    keySeparator: false,
    nsSeparator: false,
  });`;

  console.log('    For {variable} placeholder format, configure i18next:');
  console.log(config.split('\n').map(l => `    ${l}`).join('\n'));
  assert(true, '');
});

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));

if (failed > 0) {
  process.exit(1);
}
