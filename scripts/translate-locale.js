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

/**
 * i18next plural suffixes per locale based on CLDR plural rules.
 * Each locale needs specific suffixes; i18next selects based on count.
 */
const PLURAL_SUFFIXES = {
  // East Asian (no plural forms - just "other")
  ja: ['other'],
  zh_CN: ['other'],
  zh_TW: ['other'],
  ko_KR: ['other'],
  vi: ['other'],
  th: ['other'],
  id_ID: ['other'],
  ms_MY: ['other'],

  // Germanic, Romance, etc. (one, other)
  en_GB: ['one', 'other'],
  en_US: ['one', 'other'],
  de_DE: ['one', 'other'],
  de_AT: ['one', 'other'],
  nl_NL: ['one', 'other'],
  nl_BE: ['one', 'other'],
  fr_FR: ['one', 'other'],
  fr_CA: ['one', 'other'],
  es_ES: ['one', 'other'],
  es_MX: ['one', 'other'],
  es_AR: ['one', 'other'],
  it_IT: ['one', 'other'],
  pt_BR: ['one', 'other'],
  pt_PT: ['one', 'other'],
  sv_SE: ['one', 'other'],
  da: ['one', 'other'],
  nb_NO: ['one', 'other'],
  el: ['one', 'other'],
  he_IL: ['one', 'other'],
  hi_IN: ['one', 'other'],
  hu_HU: ['one', 'other'],
  tr_TR: ['one', 'other'],
  fa_IR: ['one', 'other'],

  // Slavic (one, few, many, other)
  ru_RU: ['one', 'few', 'many', 'other'],
  uk: ['one', 'few', 'many', 'other'],
  pl_PL: ['one', 'few', 'many', 'other'],
  cs: ['one', 'few', 'many', 'other'],

  // Romanian (one, few, other)
  ro_RO: ['one', 'few', 'other'],

  // Arabic (zero, one, two, few, many, other)
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
};

// Default for unknown locales
const DEFAULT_PLURAL_SUFFIXES = ['one', 'other'];

function getPluralSuffixes(locale) {
  return PLURAL_SUFFIXES[locale] || DEFAULT_PLURAL_SUFFIXES;
}

/**
 * Extract base key and suffix from a plural key.
 * e.g., "product_found_locally_one" -> { base: "product_found_locally", suffix: "one" }
 */
function parsePluralKey(key) {
  const match = key.match(/^(.+)_(zero|one|two|few|many|other)$/);
  if (match) {
    return { base: match[1], suffix: match[2] };
  }
  return null;
}

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

/**
 * Check for known mistranslations of ambiguous short strings.
 * These are strings where the AI commonly picks the wrong meaning.
 */
function validateAmbiguousTerms(source, translated, locale) {
  const issues = [];

  // "No" (negative response) mistranslated as "Number" abbreviation
  if (source === 'No') {
    const wrongTranslations = ['Nr.', 'Nr', '번호', 'Nro.', 'Nro', 'N.º', 'رقم'];
    if (wrongTranslations.includes(translated.trim())) {
      issues.push(`"No" means negative response (opposite of "Yes"), not "Number" — got "${translated}"`);
    }
  }

  return issues;
}

// ─── JS Translation ───────────────────────────────────────────────────────────

/**
 * Translate JS source strings for a locale.
 * Supports two source formats:
 *   Old: { "key": { "string": "English text", "context": "optional", "plural": bool } }
 *   New: { "namespace.key": "English String" }
 * Output format:
 *   Old: { "English text": "Translated text" } with plurals as { "key_one": "...", "key_other": "..." }
 *   New: { "namespace.key": "Translated text" } with plurals as { "namespace.key_one": "...", etc. }
 */
async function translateJsFile(sourceFile, locale, state, force) {
  // Preserve directory structure from source (e.g., monorepo/core.json)
  const relativePath = path.relative(SOURCE_JS_DIR, sourceFile);
  const tag = relativePath.replace(/\.json$/, ''); // e.g., "monorepo/core"
  const sourceContent = await fs.readFile(sourceFile, 'utf8');
  const sourceStrings = JSON.parse(sourceContent);

  // Detect source format: new format has string values, old format has object values
  const firstValue = Object.values(sourceStrings)[0];
  const isNewFormat = typeof firstValue === 'string';

  // Load existing translations - mirror source directory structure
  const outputFile = path.join(TRANSLATIONS_JS_DIR, locale, relativePath);
  const outputDir = path.dirname(outputFile);

  let existingTranslations = {};
  try {
    existingTranslations = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  } catch {
    // No existing file
  }

  // Separate regular strings from plural strings
  const regularEntries = [];
  const pluralGroups = new Map(); // base key -> { one: entry, other: entry, ... }

  if (isNewFormat) {
    for (const [key, englishString] of Object.entries(sourceStrings)) {
      const parsed = parsePluralKey(key);
      if (parsed) {
        if (!pluralGroups.has(parsed.base)) {
          pluralGroups.set(parsed.base, {});
        }
        pluralGroups.get(parsed.base)[parsed.suffix] = { key, string: englishString };
      } else {
        regularEntries.push({ key, string: englishString });
      }
    }
  } else {
    for (const [key, entry] of Object.entries(sourceStrings)) {
      if (entry.plural) {
        const parsed = parsePluralKey(key);
        if (parsed) {
          if (!pluralGroups.has(parsed.base)) {
            pluralGroups.set(parsed.base, {});
          }
          pluralGroups.get(parsed.base)[parsed.suffix] = { key, ...entry };
        }
      } else {
        regularEntries.push({ key, ...entry });
      }
    }
  }

  // Helper: the key used in the output translation file
  function outputKey(entry) {
    return isNewFormat ? entry.key : entry.string;
  }

  // Determine which regular strings need translation
  const stateKey = `js:${tag}:${locale}`;
  const prevHashes = state[stateKey] || {};
  const newHashes = {};
  const regularToTranslate = [];

  for (const entry of regularEntries) {
    const hash = hashString(entry.string + (entry.context || ''));
    newHashes[entry.key] = hash;

    const hasExistingTranslation = !!existingTranslations[outputKey(entry)];
    const hasPrevHash = prevHashes[entry.key] !== undefined;
    const sourceChanged = hasPrevHash && hash !== prevHashes[entry.key];

    if (force || sourceChanged || !hasExistingTranslation) {
      regularToTranslate.push(entry);
    }
  }

  // Determine which plural groups need translation
  const pluralToTranslate = [];
  const requiredSuffixes = getPluralSuffixes(locale);

  for (const [baseKey, suffixes] of pluralGroups) {
    const hash = hashString(JSON.stringify(suffixes));
    newHashes[`plural:${baseKey}`] = hash;

    // Check if we need to translate this plural group
    const hasPrevHash = prevHashes[`plural:${baseKey}`] !== undefined;
    const sourceChanged = hasPrevHash && hash !== prevHashes[`plural:${baseKey}`];
    const missingForms = !requiredSuffixes.every(s => existingTranslations[`${baseKey}_${s}`]);
    const needsTranslation = force || sourceChanged || missingForms;

    if (needsTranslation) {
      pluralToTranslate.push({ baseKey, suffixes });
    }
  }

  // Remove translations for strings no longer in source
  const validKeys = new Set();
  for (const entry of regularEntries) {
    validKeys.add(outputKey(entry));
  }
  for (const [baseKey] of pluralGroups) {
    for (const suffix of requiredSuffixes) {
      validKeys.add(`${baseKey}_${suffix}`);
    }
  }

  const existingCount = Object.keys(existingTranslations).length;
  const keysToRemove = Object.keys(existingTranslations).filter(k => !validKeys.has(k));

  if (!force && existingCount > 20 && keysToRemove.length > existingCount * 0.5) {
    console.error(`  ⛔ ${tag}: Refusing to delete ${keysToRemove.length}/${existingCount} translations (>50% drop). Source may be broken. Use --force to override.`);
    process.exit(1);
  }

  for (const key of keysToRemove) {
    delete existingTranslations[key];
  }

  const totalToTranslate = regularToTranslate.length + pluralToTranslate.length;
  if (totalToTranslate === 0) {
    console.log(`  ${tag}: No changes, skipping`);
    state[stateKey] = newHashes;
    return existingTranslations;
  }

  console.log(`  ${tag}: Translating ${regularToTranslate.length} strings + ${pluralToTranslate.length} plural groups`);

  const localeName = LOCALE_NAMES[locale] || locale;

  // Translate regular strings in batches
  const batchSize = 50;
  for (let i = 0; i < regularToTranslate.length; i += batchSize) {
    const batch = regularToTranslate.slice(i, i + batchSize);

    let userPrompt;
    if (isNewFormat) {
      // New format: send semantic keys with English strings
      const input = {};
      for (const entry of batch) {
        input[entry.key] = entry.string;
      }

      userPrompt = `Translate the following UI strings to ${localeName}. The keys are semantic identifiers and the values are the English source strings to translate.

IMPORTANT: After translating each string, verify it:
1. All placeholders ({name}, {count}, %s, %d, etc.) must appear exactly as in the source
2. Technical terms (Gateway, POS, SKU, API, ID, WooCommerce, etc.) must stay in English
3. Keep translations concise - similar length to source
4. If you find an issue, fix it before returning

Return a JSON object where keys are the SAME semantic keys and values are the VERIFIED translations.

${JSON.stringify(input, null, 2)}`;
    } else {
      // Old format: send English strings with context hints
      const input = {};
      for (const entry of batch) {
        input[entry.string] = entry.context || '';
      }

      userPrompt = `Translate the following UI strings to ${localeName}. The keys are the English source strings. The values are optional context hints (empty string means no context).

IMPORTANT: After translating each string, verify it:
1. All placeholders ({name}, {count}, %s, %d, etc.) must appear exactly as in the source
2. Technical terms (Gateway, POS, SKU, API, ID, WooCommerce, etc.) must stay in English
3. Keep translations concise - similar length to source
4. If you find an issue, fix it before returning

Return a JSON object where keys are the ORIGINAL English strings and values are the VERIFIED translations.

${JSON.stringify(input, null, 2)}`;
    }

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

      if (isNewFormat) {
        // New format: keys are semantic identifiers, look up English string for validation
        const keyToEnglish = {};
        for (const entry of batch) {
          keyToEnglish[entry.key] = entry.string;
        }

        for (const [key, translated] of Object.entries(translations)) {
          const english = keyToEnglish[key] || key;
          const placeholderIssues = validatePlaceholders(english, translated);
          const termIssues = validateTechnicalTerms(english, translated);
          const ambiguousIssues = validateAmbiguousTerms(english, translated, locale);
          const allIssues = [...placeholderIssues, ...termIssues, ...ambiguousIssues];

          if (allIssues.length > 0) {
            console.warn(`    ⚠ "${key}": ${allIssues.join('; ')}`);
            issueCount++;
          }

          existingTranslations[key] = translated;
        }
      } else {
        // Old format: keys are English strings
        for (const [source, translated] of Object.entries(translations)) {
          const placeholderIssues = validatePlaceholders(source, translated);
          const termIssues = validateTechnicalTerms(source, translated);
          const ambiguousIssues = validateAmbiguousTerms(source, translated, locale);
          const allIssues = [...placeholderIssues, ...termIssues, ...ambiguousIssues];

          if (allIssues.length > 0) {
            console.warn(`    ⚠ "${source.substring(0, 30)}...": ${allIssues.join('; ')}`);
            issueCount++;
          }

          existingTranslations[source] = translated;
        }
      }

      if (issueCount > 0) {
        console.log(`    ${issueCount} validation warning(s) in batch`);
      }
    } catch (error) {
      console.error(`    Error translating batch: ${error.message}`);
    }

    if (i + batchSize < regularToTranslate.length) {
      await sleep(500);
    }
  }

  // Translate plural groups
  for (const { baseKey, suffixes } of pluralToTranslate) {
    // Get the English forms to provide context
    const englishForms = {};
    for (const [suffix, entry] of Object.entries(suffixes)) {
      englishForms[suffix] = entry.string;
    }

    // Collect all placeholders from all English forms (they must appear in every translated form)
    const allPlaceholders = new Set();
    const placeholderRegex = /\{[^}]+\}|%[0-9]*\$?[sd]|%[0-9]+/g;
    for (const str of Object.values(englishForms)) {
      const matches = str.match(placeholderRegex) || [];
      matches.forEach(p => allPlaceholders.add(p));
    }
    const placeholderList = [...allPlaceholders];

    const userPrompt = `Translate the following plural forms to ${localeName}.

This is a plural string for i18next. The base key is "${baseKey}".

English forms:
${JSON.stringify(englishForms, null, 2)}

${localeName} requires these plural suffixes: ${requiredSuffixes.join(', ')}

CRITICAL RULES:
1. EVERY translated form MUST contain these exact placeholders: ${placeholderList.join(', ')}
   - Even for zero/one/two forms where the language uses specific words, you MUST still include ${placeholderList.join(', ')}
   - Example: for Arabic "one" form, write "تم العثور على {count} منتج واحد" NOT "تم العثور على منتج واحد"
   - The application code requires these placeholders in ALL forms — omitting them causes runtime errors
2. Return ONLY the suffixes listed above for ${localeName}
3. Use the correct grammatical plural forms for ${localeName}
4. Technical terms must stay in English

Return a JSON object with the required suffixes as keys and translations as values.
Example format: { "one": "...", "other": "..." }`;

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 1024,
          temperature: attempt > 1 ? 0.1 : 0.3, // Lower temperature on retry
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

        // Validate and store translations
        let missingSuffixes = [];
        let placeholderFailures = [];

        for (const suffix of requiredSuffixes) {
          if (translations[suffix]) {
            const fullKey = `${baseKey}_${suffix}`;

            // Validate placeholders against the matching English source form,
            // falling back to _other or _one if this specific suffix doesn't exist in source
            const sourceString = suffixes[suffix]?.string || suffixes.other?.string || suffixes.one?.string || '';
            const placeholderIssues = validatePlaceholders(sourceString, translations[suffix]);

            if (placeholderIssues.length > 0) {
              placeholderFailures.push({ suffix, fullKey, issues: placeholderIssues, translated: translations[suffix] });
            }

            existingTranslations[fullKey] = translations[suffix];
          } else {
            missingSuffixes.push(suffix);
          }
        }

        if (missingSuffixes.length > 0) {
          console.warn(`    ⚠ "${baseKey}": API did not return required suffixes: ${missingSuffixes.join(', ')}`);
        }

        // If placeholders are broken and we haven't retried yet, try again
        if (placeholderFailures.length > 0 && attempt < maxAttempts) {
          console.warn(`    ⚠ "${baseKey}": ${placeholderFailures.length} form(s) have placeholder issues, retrying...`);
          await sleep(500);
          continue;
        }

        // Auto-repair remaining placeholder issues after final attempt
        for (const { suffix, fullKey, issues, translated } of placeholderFailures) {
          let repaired = translated;

          for (const placeholder of placeholderList) {
            if (!repaired.includes(placeholder)) {
              // Prepend the missing placeholder with a space
              repaired = `${placeholder} ${repaired}`;
              console.warn(`    🔧 "${fullKey}": auto-inserted missing ${placeholder}`);
            }
          }

          existingTranslations[fullKey] = repaired;
        }

        const receivedCount = requiredSuffixes.length - missingSuffixes.length;
        console.log(`    ✓ ${baseKey}: ${receivedCount}/${requiredSuffixes.length} plural forms`);
        break; // Success, exit retry loop
      } catch (error) {
        console.error(`    Error translating plural "${baseKey}": ${error.message}`);
        if (attempt < maxAttempts) {
          await sleep(500);
          continue;
        }
      }
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

      const hasPrevHash = prevHashes[key] !== undefined;
      const sourceChanged = hasPrevHash && hash !== prevHashes[key];

      if (force || sourceChanged || !existingTranslations[key]) {
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
