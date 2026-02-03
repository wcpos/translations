#!/usr/bin/env node

/**
 * Translate source strings to a single locale with built-in verification.
 * Supports both JS (JSON) and PHP (POT/PO) formats.
 * Includes incremental translation — only translates new/changed strings.
 *
 * Each translation is verified against quality rules before being saved:
 * - Placeholders preserved
 * - Technical terms kept in English
 * - Appropriate length
 * - Correct terminology
 *
 * Usage:
 *   node scripts/translate-locale.js <locale> [--type js|php|all] [--force]
 */

const OpenAI = require('openai').default;
const fs = require('fs').promises;
const path = require('path');
const gettextParser = require('gettext-parser');
const { glob } = require('glob');

const openai = new OpenAI();

const LOCALE_NAMES = require('../locales.json');

const SOURCE_JS_DIR = path.resolve(__dirname, '../source/js');
const SOURCE_PHP_DIR = path.resolve(__dirname, '../source/php');
const TRANSLATIONS_JS_DIR = path.resolve(__dirname, '../translations/js');
const TRANSLATIONS_PHP_DIR = path.resolve(__dirname, '../translations/php');
const STATE_FILE = path.resolve(__dirname, '../.translation-state.json');

let translationContext = '';

async function loadTranslationContext() {
  try {
    const contextPath = path.join(__dirname, 'translation-context.md');
    translationContext = await fs.readFile(contextPath, 'utf8');
  } catch {
    console.warn('Warning: Could not load translation-context.md');
  }
}

async function loadState() {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hashString(str) {
  // Simple hash for change detection
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Validate placeholders are preserved in translation.
 * Returns array of issues, empty if valid.
 */
function validatePlaceholders(source, translated) {
  const issues = [];
  const placeholderRegex = /\{[^}]+\}|%[0-9]*\$?[sd]|%[0-9]+/g;

  const sourcePlaceholders = (source.match(placeholderRegex) || []).sort();
  const translatedPlaceholders = (translated.match(placeholderRegex) || []).sort();

  if (JSON.stringify(sourcePlaceholders) !== JSON.stringify(translatedPlaceholders)) {
    issues.push(`Placeholder mismatch: source has [${sourcePlaceholders.join(', ')}], translation has [${translatedPlaceholders.join(', ')}]`);
  }

  return issues;
}

/**
 * Check if translation contains critical technical terms that MUST stay in English.
 * Only flags the most critical terms - some like "Barcode" may have standard translations.
 */
function validateTechnicalTerms(source, translated) {
  const issues = [];
  // Only the most critical terms that must stay in English
  const criticalTerms = [
    'Gateway', 'Gateways', 'POS', 'SKU', 'API', 'JSON', 'ID', 'UUID',
    'Webhook', 'Token', 'OAuth',
    'WCPOS', 'WooCommerce', 'WordPress', 'Stripe', 'PayPal', 'Square',
  ];

  for (const term of criticalTerms) {
    const regex = new RegExp(`\\b${term}\\b`, 'i');
    if (regex.test(source) && !regex.test(translated)) {
      issues.push(`Critical term "${term}" must stay in English`);
    }
  }

  return issues;
}

// ─── JS Translation ───────────────────────────────────────────────────────────

/**
 * Translate JS source strings for a locale.
 * Source format: { "key": { "string": "English text", "context": "optional" } }
 * Output format: { "English text": "Translated text" }
 */
async function translateJsFile(sourceFile, locale, state, force) {
  // Preserve directory structure from source (e.g., monorepo/core.json)
  const relativePath = path.relative(SOURCE_JS_DIR, sourceFile);
  const tag = relativePath.replace(/\.json$/, ''); // e.g., "monorepo/core"
  const sourceContent = await fs.readFile(sourceFile, 'utf8');
  const sourceStrings = JSON.parse(sourceContent);

  // Load existing translations - mirror source directory structure
  const outputFile = path.join(TRANSLATIONS_JS_DIR, locale, relativePath);
  const outputDir = path.dirname(outputFile);

  let existingTranslations = {};
  try {
    existingTranslations = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  } catch {
    // No existing file
  }

  // Determine which strings need translation
  const stateKey = `js:${tag}:${locale}`;
  const prevHashes = state[stateKey] || {};
  const newHashes = {};
  const toTranslate = [];

  for (const [key, entry] of Object.entries(sourceStrings)) {
    const hash = hashString(entry.string + (entry.context || ''));
    newHashes[key] = hash;

    if (force || hash !== prevHashes[key] || !existingTranslations[entry.string]) {
      toTranslate.push(entry);
    }
  }

  // Remove translations for strings no longer in source
  const sourceStringSet = new Set(Object.values(sourceStrings).map(e => e.string));
  for (const key of Object.keys(existingTranslations)) {
    if (!sourceStringSet.has(key)) {
      delete existingTranslations[key];
    }
  }

  if (toTranslate.length === 0) {
    console.log(`  ${tag}: No changes, skipping`);
    state[stateKey] = newHashes;
    return existingTranslations;
  }

  console.log(`  ${tag}: Translating ${toTranslate.length} of ${Object.keys(sourceStrings).length} strings`);

  // Batch strings for translation (groups of 50 to stay within token limits)
  const batchSize = 50;
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    const batch = toTranslate.slice(i, i + batchSize);

    const input = {};
    for (const entry of batch) {
      input[entry.string] = entry.context || '';
    }

    const localeName = LOCALE_NAMES[locale] || locale;
    const userPrompt = `Translate the following UI strings to ${localeName}. The keys are the English source strings. The values are optional context hints (empty string means no context).

IMPORTANT: After translating each string, verify it:
1. All placeholders ({name}, {count}, %s, %d, etc.) must appear exactly as in the source
2. Technical terms (Gateway, POS, SKU, API, ID, WooCommerce, etc.) must stay in English
3. Keep translations concise - similar length to source
4. If you find an issue, fix it before returning

Return a JSON object where keys are the ORIGINAL English strings and values are the VERIFIED translations.

${JSON.stringify(input, null, 2)}`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0.3,
        messages: [
          { role: 'system', content: translationContext || 'You are a professional translator for POS software UI.' },
          { role: 'user', content: userPrompt },
        ],
      });

      let text = response.choices[0].message.content.trim();

      // Strip code fence if present
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const translations = JSON.parse(text);

      // Local validation as safety net
      let issueCount = 0;
      for (const [source, translated] of Object.entries(translations)) {
        const placeholderIssues = validatePlaceholders(source, translated);
        const termIssues = validateTechnicalTerms(source, translated);
        const allIssues = [...placeholderIssues, ...termIssues];

        if (allIssues.length > 0) {
          console.warn(`    ⚠ "${source.substring(0, 30)}...": ${allIssues.join('; ')}`);
          issueCount++;
        }

        existingTranslations[source] = translated;
      }

      if (issueCount > 0) {
        console.log(`    ${issueCount} validation warning(s) in batch`);
      }
    } catch (error) {
      console.error(`    Error translating batch: ${error.message}`);
    }

    await sleep(500);
  }

  // Write output
  await fs.mkdir(outputDir, { recursive: true });

  // Sort keys for stable output
  const sorted = {};
  for (const key of Object.keys(existingTranslations).sort()) {
    sorted[key] = existingTranslations[key];
  }

  await fs.writeFile(outputFile, JSON.stringify(sorted, null, 2) + '\n');
  state[stateKey] = newHashes;

  console.log(`  ${tag}: Written ${Object.keys(sorted).length} translations → ${outputFile}`);
  return sorted;
}

// ─── PHP Translation ──────────────────────────────────────────────────────────

/**
 * Translate PHP POT file to a locale, producing a PO file.
 */
async function translatePhpFile(potFile, locale, state, force) {
  const domain = path.basename(potFile, '.pot');
  const potContent = await fs.readFile(potFile);
  const pot = gettextParser.po.parse(potContent);

  // Load existing PO if available
  const outputDir = path.join(TRANSLATIONS_PHP_DIR, locale);
  const poFile = path.join(outputDir, `${domain}-${locale}.po`);

  let existingPo = null;
  try {
    existingPo = gettextParser.po.parse(await fs.readFile(poFile));
  } catch {
    // No existing file
  }

  // Build lookup of existing translations
  const existingTranslations = {};
  if (existingPo) {
    for (const [ctx, entries] of Object.entries(existingPo.translations)) {
      for (const [msgid, entry] of Object.entries(entries)) {
        if (msgid && entry.msgstr && entry.msgstr[0]) {
          const key = ctx ? `${ctx}\x04${msgid}` : msgid;
          existingTranslations[key] = entry.msgstr;
        }
      }
    }
  }

  // Determine which strings need translation
  const stateKey = `php:${domain}:${locale}`;
  const prevHashes = state[stateKey] || {};
  const newHashes = {};
  const toTranslate = [];

  for (const [ctx, entries] of Object.entries(pot.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (!msgid) continue; // Skip header

      const key = ctx ? `${ctx}\x04${msgid}` : msgid;
      const hash = hashString(msgid + (ctx || '') + (entry.msgid_plural || ''));
      newHashes[key] = hash;

      if (force || hash !== prevHashes[key] || !existingTranslations[key]) {
        toTranslate.push({ msgid, msgid_plural: entry.msgid_plural, context: ctx || null });
      }
    }
  }

  if (toTranslate.length === 0) {
    console.log(`  ${domain}: No changes, skipping`);
    state[stateKey] = newHashes;
    return;
  }

  console.log(`  ${domain}: Translating ${toTranslate.length} strings`);

  // Batch and translate
  const batchSize = 50;
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    const batch = toTranslate.slice(i, i + batchSize);

    const input = batch.map(entry => ({
      msgid: entry.msgid,
      ...(entry.msgid_plural && { msgid_plural: entry.msgid_plural }),
      ...(entry.context && { context: entry.context }),
    }));

    const localeName = LOCALE_NAMES[locale] || locale;
    const userPrompt = `Translate the following WordPress plugin strings to ${localeName}.

For each entry, provide:
- "msgstr": the translated string
- If "msgid_plural" is present, provide "msgstr_plural" with forms for the target language

IMPORTANT: After translating each string, verify it:
1. All printf placeholders (%s, %d, %1$s, etc.) must appear exactly as in the source
2. Technical terms (Gateway, POS, SKU, API, ID, WooCommerce, etc.) must stay in English
3. Keep translations concise
4. If you find an issue, fix it before returning

Return a JSON array with the VERIFIED translations in the same order.

${JSON.stringify(input, null, 2)}`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4096,
        temperature: 0.3,
        messages: [
          { role: 'system', content: translationContext || 'You are a professional translator for POS software UI.' },
          { role: 'user', content: userPrompt },
        ],
      });

      let text = response.choices[0].message.content.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const translations = JSON.parse(text);

      let issueCount = 0;
      for (let j = 0; j < batch.length && j < translations.length; j++) {
        const entry = batch[j];
        const translated = translations[j];
        const key = entry.context ? `${entry.context}\x04${entry.msgid}` : entry.msgid;

        // Validate the translation
        if (translated.msgstr) {
          const placeholderIssues = validatePlaceholders(entry.msgid, translated.msgstr);
          const termIssues = validateTechnicalTerms(entry.msgid, translated.msgstr);
          const allIssues = [...placeholderIssues, ...termIssues];

          if (allIssues.length > 0) {
            console.warn(`    ⚠ "${entry.msgid.substring(0, 30)}...": ${allIssues.join('; ')}`);
            issueCount++;
          }

          existingTranslations[key] = [translated.msgstr];
        }
        if (translated.msgstr_plural) {
          existingTranslations[key] = Array.isArray(translated.msgstr_plural)
            ? translated.msgstr_plural
            : [translated.msgstr || '', translated.msgstr_plural];
        }
      }

      if (issueCount > 0) {
        console.log(`    ${issueCount} validation warning(s) in batch`);
      }
    } catch (error) {
      console.error(`    Error translating batch: ${error.message}`);
    }

    await sleep(500);
  }

  // Build output PO
  const outputPo = JSON.parse(JSON.stringify(pot)); // Deep clone

  // Update header
  const localeName = LOCALE_NAMES[locale] || locale;
  if (outputPo.translations[''] && outputPo.translations['']['']) {
    outputPo.translations[''][''].msgstr[0] = outputPo.translations[''][''].msgstr[0]
      .replace(/Language: \\n/, `Language: ${locale}\\n`)
      .replace(/PO-Revision-Date: .*\\n/, `PO-Revision-Date: ${new Date().toISOString()}\\n`);
  }

  // Apply translations
  for (const [ctx, entries] of Object.entries(outputPo.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (!msgid) continue;
      const key = ctx ? `${ctx}\x04${msgid}` : msgid;
      if (existingTranslations[key]) {
        entry.msgstr = existingTranslations[key];
      }
    }
  }

  // Write PO file
  await fs.mkdir(outputDir, { recursive: true });
  const poBuffer = gettextParser.po.compile(outputPo);
  await fs.writeFile(poFile, poBuffer);

  state[stateKey] = newHashes;
  console.log(`  ${domain}: Written → ${poFile}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const locale = process.argv[2];
  if (!locale) {
    console.error('Usage: node translate-locale.js <locale> [--type js|php|all] [--force]');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY required');
    process.exit(1);
  }

  const typeIdx = process.argv.indexOf('--type');
  const type = typeIdx !== -1 ? process.argv[typeIdx + 1] : 'all';
  const force = process.argv.includes('--force');

  await loadTranslationContext();
  const state = await loadState();
  const localeName = LOCALE_NAMES[locale] || locale;

  console.log(`Translating to ${locale} (${localeName})${force ? ' [FORCE]' : ''}\n`);

  // JS translations
  if (type === 'js' || type === 'all') {
    console.log('--- JS Translations ---');
    const jsFiles = await glob('**/*.json', { cwd: SOURCE_JS_DIR, absolute: true });
    if (jsFiles.length === 0) {
      console.log('  No JS source files found. Run extract:js first.\n');
    } else {
      for (const file of jsFiles) {
        await translateJsFile(file, locale, state, force);
      }
      console.log();
    }
  }

  // PHP translations
  if (type === 'php' || type === 'all') {
    console.log('--- PHP Translations ---');
    const potFiles = await glob('*.pot', { cwd: SOURCE_PHP_DIR, absolute: true });
    if (potFiles.length === 0) {
      console.log('  No PHP source files found. Run extract:php first.\n');
    } else {
      for (const file of potFiles) {
        await translatePhpFile(file, locale, state, force);
      }
      console.log();
    }
  }

  await saveState(state);
  console.log('Done.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
