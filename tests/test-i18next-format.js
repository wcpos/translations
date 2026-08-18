#!/usr/bin/env node

/**
 * Test that translation output format is compatible with react-i18next.
 *
 * Tests:
 * 1. JSON structure is valid for i18next resource bundle
 * 2. Placeholders use i18next interpolation format
 * 3. Keys match source strings (natural language or semantic keys)
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

/**
 * Detect whether a source file uses the new format (flat key→string)
 * or old format (key→{string, files, ...}).
 */
function isNewSourceFormat(source) {
  const firstValue = Object.values(source)[0];
  return typeof firstValue === 'string';
}

/**
 * Get English strings from a source file, regardless of format.
 * Returns a Map of outputKey → englishString.
 */
function getEnglishStrings(source) {
  const map = new Map();
  if (isNewSourceFormat(source)) {
    for (const [key, str] of Object.entries(source)) {
      map.set(key, str);
    }
  } else {
    for (const [, entry] of Object.entries(source)) {
      map.set(entry.string, entry.string);
    }
  }
  return map;
}

/**
 * Get the expected translation keys for a source file.
 */
function getExpectedTranslationKeys(source) {
  if (isNewSourceFormat(source)) {
    return new Set(Object.keys(source));
  } else {
    return new Set(Object.values(source).map(e => e.string));
  }
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
      let semanticCount = 0;
      let naturalCount = 0;
      for (const [key, value] of Object.entries(translations)) {
        assert(
          typeof value === 'string',
          `key "${key}" has non-string value: ${typeof value}`
        );
        // Count key types
        if (key.includes('.') && !key.includes(' ')) {
          semanticCount++;
        } else {
          naturalCount++;
        }
      }
      const total = Object.keys(translations).length;
      if (semanticCount > naturalCount) {
        console.log(`    (semantic key format: ${semanticCount}/${total} keys)`);
      } else {
        console.log(`    (natural language key format: ${naturalCount}/${total} keys)`);
      }
    });

    test('translation keys are consistent format', () => {
      const keys = Object.keys(translations);
      // Check for either semantic keys (dot-notation) or natural language keys
      const semanticKeys = keys.filter(k => k.includes('.') && !k.includes(' '));
      const naturalKeys = keys.filter(k => k.includes(' ') || k.length > 20);
      const hasConsistentFormat = semanticKeys.length > keys.length * 0.5 ||
                                   naturalKeys.length > keys.length * 0.1;
      assert(hasConsistentFormat, 'expected consistent key format (semantic or natural language)');
    });

    test('translations are non-empty strings', () => {
      for (const [key, value] of Object.entries(translations)) {
        assert(value.length > 0, `key "${key}" has empty translation`);
      }
    });
  }
}

// ─── Placeholder Format ────────────────────────────────────────────────────────

const koreanCoreFile = findTranslationFile(path.join(TRANSLATIONS_DIR, 'ko_KR'), 'core.json');
if (koreanCoreFile) {
  const koreanTranslations = JSON.parse(fs.readFileSync(koreanCoreFile, 'utf8'));

  test('Korean recovery distinguishes discarded changes from deleted records', () => {
    const nonDestructiveKeys = [
      'body', 'discard', 'discard_body', 'discard_confirm', 'discard_failed',
      'discard_maybe_title', 'discard_title', 'discarded',
    ];
    for (const suffix of nonDestructiveKeys) {
      const key = `health.database.rejected.${suffix}`;
      assert(!koreanTranslations[key].includes('삭제'), `${key} must not use delete wording`);
    }
    assert(koreanTranslations['health.database.rejected.discard'] === '버리기',
      'ordinary recovery action must use discard wording');
    assert(koreanTranslations['health.database.rejected.discard_confirm'] === '버리기',
      'ordinary recovery confirmation must use discard wording');
    assert(koreanTranslations['health.database.rejected.discard_maybe_body'].includes('버릴 때'),
      'conditional recovery copy must describe discarding the change');
    assert(koreanTranslations['health.database.rejected.discard_destroy_confirm'] === '삭제',
      'destructive record removal must retain delete wording');
  });
}

console.log('\nTesting placeholder format...');

if (locales.length > 0) {
  const sampleLocale = locales[0];
  const sampleFile = findTranslationFile(path.join(TRANSLATIONS_DIR, sampleLocale), 'core.json');

  if (sampleFile) {
    const translations = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));

    test('placeholders use {variable} format and are preserved', () => {
      // Load source to know the English strings for each key
      let sourceEnglish = null;
      const sourceFile = path.join(SOURCE_DIR, 'monorepo', 'core.json');
      if (fs.existsSync(sourceFile)) {
        const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
        sourceEnglish = getEnglishStrings(source);
      }

      for (const [key, value] of Object.entries(translations)) {
        // Get the English source string for this key
        const english = sourceEnglish?.get(key) || key;

        const keyPlaceholders = [...english.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
        if (keyPlaceholders.length === 0) continue;

        const valuePlaceholders = [...value.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

        for (const p of keyPlaceholders) {
          assert(
            valuePlaceholders.includes(p),
            `placeholder {${p}} missing in translation of "${key}"`
          );
        }
      }
    });

    test('no double-brace {{variable}} format detected', () => {
      const doublebraceCount = Object.values(translations).filter(v =>
        v.includes('{{') && v.includes('}}')
      ).length;
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
    const expectedKeys = getExpectedTranslationKeys(source);

    const sampleLocale = locales[0];
    const translationFile = findTranslationFile(path.join(TRANSLATIONS_DIR, sampleLocale), 'core.json');

    if (translationFile) {
      const translations = JSON.parse(fs.readFileSync(translationFile, 'utf8'));
      const translationKeys = new Set(Object.keys(translations));

      test('translation keys match source', () => {
        const mismatched = [];
        for (const key of translationKeys) {
          if (!expectedKeys.has(key)) {
            mismatched.push(key);
          }
        }
        // Allow some orphaned translations (from previous versions) and plural suffixes
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
    const englishStrings = getEnglishStrings(source);
    const strings = [...englishStrings.values()];

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
