#!/usr/bin/env node

/**
 * Quality assurance for translations using back-translation.
 *
 * For each translated string:
 * 1. Translate it back to English using GPT-4o
 * 2. Compare with the original source string
 * 3. Flag issues where meaning has shifted
 * 4. Optionally auto-correct problematic translations
 *
 * Usage:
 *   node scripts/qa-translations.js <locale> [--type js|php|all] [--apply-fixes] [--structural-only]
 */

const OpenAI = require('openai').default;
const fs = require('fs').promises;
const path = require('path');
const gettextParser = require('gettext-parser');
const { glob } = require('glob');

let openai;

const LOCALE_NAMES = require('../locales.json');

const TRANSLATIONS_JS_DIR = path.resolve(__dirname, '../translations/js');
const TRANSLATIONS_PHP_DIR = path.resolve(__dirname, '../translations/php');

// Strings that are expected to remain identical in translation
const KEEP_IN_ENGLISH = new Set([
  'WCPOS', 'WooCommerce', 'WordPress', 'WooCommerce POS',
  'POS', 'SKU', 'API', 'REST API', 'JSON', 'PHP', 'CSS', 'HTML', 'URL', 'ID', 'UUID',
  'Stripe', 'PayPal', 'Square',
  'Barcode', 'WP Admin', 'WordPress Admin', 'Online',
  // Common loanwords used as-is in many languages
  'Code', 'Name', 'Server', 'Status', 'Tags', 'App', 'Login', 'Logout', 'Email', 'Version',
]);

let translationContext = '';

async function loadTranslationContext() {
  try {
    translationContext = await fs.readFile(path.join(__dirname, 'translation-context.md'), 'utf8');
  } catch { /* ignore */ }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Back-translate a batch of strings and score them.
 */
async function backTranslateBatch(translations, locale) {
  const localeName = LOCALE_NAMES[locale] || locale;

  const prompt = `You are a quality assurance reviewer. Below are UI strings that were translated from English to ${localeName}.

For each entry, translate the "${localeName}" text back to English, then compare with the original.

Return a JSON array where each item has:
- "original": the original English string
- "back_translated": your English back-translation
- "score": 0-100 (100 = perfect match in meaning)
- "issue": null if score >= 90, otherwise a brief description of the problem
- "suggested_fix": null if no issue, otherwise a better translation in ${localeName}

Entries:
${JSON.stringify(translations, null, 2)}`;

  if (!openai) openai = new OpenAI();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4096,
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are a translation quality reviewer for a Point of Sale application.' },
      { role: 'user', content: prompt },
    ],
  });

  let text = response.choices[0].message.content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  return JSON.parse(text);
}

/**
 * Structural checks for JS translations (no AI needed).
 * Supports both old format (English string keys) and new format (semantic keys).
 */
function structuralCheckJs(source, translations, locale) {
  const issues = [];
  const placeholderRegex = /\{[^}]+\}/g;
  const isEnglishVariant = locale && locale.startsWith('en');

  // Detect source format
  const isNewFormat = source && typeof Object.values(source)[0] === 'string';

  // Build lookup from translation key to English source string
  const keyToEnglish = {};
  if (source && isNewFormat) {
    for (const [key, englishString] of Object.entries(source)) {
      keyToEnglish[key] = englishString;
    }
  }

  // Plural suffix pattern for resolving extra plural forms not in source
  const pluralSuffixPattern = /^(.+)_(zero|one|two|few|many|other)$/;

  for (const [translationKey, translated] of Object.entries(translations)) {
    // For new format, look up the English source string; for old format, the key IS the English string
    let englishStr;
    if (isNewFormat) {
      englishStr = keyToEnglish[translationKey];
      // For plural suffix keys not directly in source (e.g., _few, _many, _zero),
      // look up the base key's _one or _other form for placeholder comparison
      if (!englishStr) {
        const match = translationKey.match(pluralSuffixPattern);
        if (match) {
          const base = match[1];
          englishStr = keyToEnglish[`${base}_one`] || keyToEnglish[`${base}_other`];
        }
      }
      if (!englishStr) englishStr = translationKey;
    } else {
      englishStr = translationKey;
    }

    // Check placeholders are preserved
    const sourcePlaceholders = (englishStr.match(placeholderRegex) || []).sort();
    const translatedPlaceholders = (translated.match(placeholderRegex) || []).sort();

    if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(translatedPlaceholders)) {
      issues.push({
        string: translationKey,
        issue: `Placeholder mismatch: source has ${sourcePlaceholders.join(', ')} but translation has ${translatedPlaceholders.join(', ')}`,
        severity: 'high',
      });
    }

    // Check for untranslated strings (same as source)
    if (!isEnglishVariant && englishStr === translated && !KEEP_IN_ENGLISH.has(englishStr.trim())) {
      const stripped = englishStr.replace(/\{[^}]+\}/g, '').trim();
      const words = stripped.split(/[\s:,]+/).filter(w => w.length > 0);
      const allKept = words.every(w => KEEP_IN_ENGLISH.has(w));
      if (!allKept && words.length > 2) {
        issues.push({
          string: translationKey,
          issue: 'String appears untranslated (identical to source)',
          severity: 'medium',
        });
      }
    }
  }

  // Check all source strings have translations
  if (source) {
    if (isNewFormat) {
      for (const key of Object.keys(source)) {
        if (!translations[key]) {
          issues.push({
            string: key,
            issue: 'Missing translation',
            severity: 'high',
          });
        }
      }
    } else {
      for (const [, entry] of Object.entries(source)) {
        if (!translations[entry.string]) {
          issues.push({
            string: entry.string,
            issue: 'Missing translation',
            severity: 'high',
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Structural checks for PHP translations.
 */
function structuralCheckPhp(potPath, poPath) {
  const issues = [];

  try {
    const pot = gettextParser.po.parse(require('fs').readFileSync(potPath));
    const po = gettextParser.po.parse(require('fs').readFileSync(poPath));

    const printfRegex = /%[0-9]*\$?[sd]/g;

    for (const [ctx, entries] of Object.entries(pot.translations)) {
      for (const [msgid, potEntry] of Object.entries(entries)) {
        if (!msgid) continue;

        const poEntry = po.translations[ctx]?.[msgid];

        if (!poEntry || !poEntry.msgstr?.[0]) {
          issues.push({ string: msgid, issue: 'Missing translation', severity: 'high' });
          continue;
        }

        // Check printf placeholders
        const sourcePlaceholders = (msgid.match(printfRegex) || []).sort();
        const translatedPlaceholders = (poEntry.msgstr[0].match(printfRegex) || []).sort();

        if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(translatedPlaceholders)) {
          issues.push({
            string: msgid,
            issue: `Printf placeholder mismatch`,
            severity: 'high',
          });
        }
      }
    }
  } catch (error) {
    issues.push({ string: '', issue: `Parse error: ${error.message}`, severity: 'high' });
  }

  return issues;
}

async function main() {
  const locale = process.argv[2];
  if (!locale) {
    console.error('Usage: node qa-translations.js <locale> [--type js|php|all] [--apply-fixes] [--structural-only]');
    process.exit(1);
  }

  const typeIdx = process.argv.indexOf('--type');
  const type = typeIdx !== -1 ? process.argv[typeIdx + 1] : 'all';
  const applyFixes = process.argv.includes('--apply-fixes');
  const structuralOnly = process.argv.includes('--structural-only');

  if (!structuralOnly && !process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY required (or use --structural-only)');
    process.exit(1);
  }

  await loadTranslationContext();

  const localeName = LOCALE_NAMES[locale] || locale;
  console.log(`QA checking translations for ${locale} (${localeName})\n`);

  let totalIssues = 0;
  let totalFixed = 0;

  // JS QA
  if (type === 'js' || type === 'all') {
    console.log('--- JS Translations ---');
    const jsFiles = await glob('**/*.json', { cwd: path.join(TRANSLATIONS_JS_DIR, locale), absolute: true });

    for (const file of jsFiles) {
      const localeDir = path.join(TRANSLATIONS_JS_DIR, locale);
      const relPath = path.relative(localeDir, file);
      const tag = relPath.replace(/\.json$/, '');
      const translations = JSON.parse(await fs.readFile(file, 'utf8'));

      // Load source for structural checks — match directory structure
      let source = null;
      try {
        const sourceFile = path.resolve(__dirname, '../source/js', relPath);
        source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
      } catch {
        // Try glob fallback for flat structure
        try {
          const basename = path.basename(file, '.json');
          const sourceFiles = await glob(`**/${basename}.json`, { cwd: path.resolve(__dirname, '../source/js'), absolute: true });
          if (sourceFiles.length > 0) {
            source = JSON.parse(await fs.readFile(sourceFiles[0], 'utf8'));
          }
        } catch { /* ignore */ }
      }

      // Structural checks
      const structIssues = structuralCheckJs(source, translations, locale);
      if (structIssues.length > 0) {
        console.log(`  ${tag}: ${structIssues.length} structural issue(s)`);
        for (const issue of structIssues) {
          console.log(`    [${issue.severity}] "${issue.string.substring(0, 40)}..." - ${issue.issue}`);
        }
        totalIssues += structIssues.length;
      }

      // Back-translation QA
      if (!structuralOnly) {
        // For new format, send English strings (not semantic keys) for back-translation
        const entries = Object.entries(translations).map(([key, translated]) => ({
          original: (source && isNewFormat) ? (keyToEnglish[key] || key) : key,
          key: key,
          translated,
        }));

        const batchSize = 30;
        for (let i = 0; i < entries.length; i += batchSize) {
          const batch = entries.slice(i, i + batchSize);
          try {
            const results = await backTranslateBatch(batch, locale);

            for (const result of results) {
              if (result.score < 90) {
                console.log(`    [score:${result.score}] "${result.original.substring(0, 40)}..." - ${result.issue}`);
                totalIssues++;

                if (applyFixes && result.suggested_fix) {
                  translations[result.original] = result.suggested_fix;
                  totalFixed++;
                }
              }
            }
          } catch (error) {
            console.error(`    Error in back-translation batch: ${error.message}`);
          }
          await sleep(500);
        }

        if (applyFixes && totalFixed > 0) {
          const sorted = {};
          for (const key of Object.keys(translations).sort()) {
            sorted[key] = translations[key];
          }
          await fs.writeFile(file, JSON.stringify(sorted, null, 2) + '\n');
        }
      }
    }
    console.log();
  }

  // PHP QA
  if (type === 'php' || type === 'all') {
    console.log('--- PHP Translations ---');
    const poFiles = await glob('*.po', { cwd: path.join(TRANSLATIONS_PHP_DIR, locale), absolute: true });

    for (const poFile of poFiles) {
      const basename = path.basename(poFile, '.po');
      // Extract domain from filename (e.g., woocommerce-pos-de_AT.po → woocommerce-pos)
      const domain = basename.replace(/-[a-z]{2}([_-][A-Z]{2})?$/, '');
      const potFile = path.join(path.resolve(__dirname, '../source/php'), `${domain}.pot`);

      const structIssues = structuralCheckPhp(potFile, poFile);
      if (structIssues.length > 0) {
        console.log(`  ${basename}: ${structIssues.length} structural issue(s)`);
        for (const issue of structIssues) {
          console.log(`    [${issue.severity}] "${issue.string.substring(0, 40)}..." - ${issue.issue}`);
        }
        totalIssues += structIssues.length;
      }
    }
    console.log();
  }

  console.log(`\nTotal issues: ${totalIssues}`);
  if (applyFixes) {
    console.log(`Auto-fixed: ${totalFixed}`);
  }

  if (totalIssues > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
