#!/usr/bin/env node

/**
 * Score translation quality by testing random samples.
 *
 * Picks random strings, translates them, back-translates, and scores.
 *
 * Usage:
 *   OPENAI_API_KEY=... node tests/score-translation.js [locale] [--sample N]
 */

const fs = require('fs').promises;
const path = require('path');

let openai;

const LOCALE = process.argv[2] || 'de_DE';
const SAMPLE_SIZE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '20');

const SOURCE_JS_DIR = path.resolve(__dirname, '../source/js');
const LOCALES = require('../locales.json');

let translationContext = '';

function getOpenAIClient() {
  if (openai) return openai;
  let OpenAI;
  try {
    OpenAI = require('openai').default;
  } catch {
    throw new Error('The openai package is required for API-backed scoring. Install it locally before running this optional test.');
  }
  openai = new OpenAI();
  return openai;
}

async function loadContext() {
  translationContext = await fs.readFile(
    path.join(__dirname, '../scripts/translation-context.md'),
    'utf8'
  );
}

async function loadRandomStrings(count) {
  const { glob } = await import('glob');
  const files = await glob('**/*.json', { cwd: SOURCE_JS_DIR, absolute: true });

  const allStrings = [];
  for (const file of files) {
    const content = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const [key, entry] of Object.entries(content)) {
      allStrings.push({
        string: entry.string,
        context: entry.context,
        file: path.basename(file, '.json'),
      });
    }
  }

  // Shuffle and pick random sample
  const shuffled = allStrings.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

async function translateStrings(strings, locale) {
  const localeName = LOCALES[locale] || locale;

  const input = {};
  for (const entry of strings) {
    input[entry.string] = entry.context || '';
  }

  const response = await getOpenAIClient().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4096,
    temperature: 0.3,
    messages: [
      { role: 'system', content: translationContext },
      {
        role: 'user',
        content: `Translate the following UI strings to ${localeName}. The keys are the English source strings. The values are optional context hints (empty string means no context).

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

async function scoreTranslations(original, translations, locale) {
  const localeName = LOCALES[locale] || locale;

  const entries = Object.entries(translations).map(([source, translated]) => ({
    original: source,
    translated,
  }));

  const response = await getOpenAIClient().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 8192,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You are a strict translation quality reviewer for a Point of Sale (POS) application.

Score each translation 0-100 based on:
- Meaning preservation (40 points): Does it convey the exact same meaning?
- Conciseness (20 points): Is it approximately the same length? No unnecessary words added?
- Technical terms (20 points): Are technical terms (Gateway, Key, ID, SKU, API) kept in English?
- Placeholders (20 points): Are {placeholders} preserved exactly?

Be STRICT. Common mistakes that should score LOW:
- "Gateway" translated instead of kept in English → -20
- "Key" translated to keyboard key instead of identifier → -20
- "State" over-localized to country-specific term → -15
- "Void" expanded to "Void transaction" → -15
- "Qty" expanded to full word → -10
- "rates" translated as "sentences" → -20
- Extra words added that weren't in source → -15
- Abbreviations expanded → -10`,
      },
      {
        role: 'user',
        content: `Review these ${localeName} translations. For each entry:
1. Back-translate to English
2. Compare with original
3. Score 0-100
4. Note any issues

Return JSON array:
[
  {
    "original": "source string",
    "translated": "translation",
    "back_translated": "back to English",
    "score": 0-100,
    "issues": ["issue1", "issue2"] or []
  }
]

Entries to review:
${JSON.stringify(entries, null, 2)}`,
      },
    ],
  });

  let text = response.choices[0].message.content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  return JSON.parse(text);
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Translation Quality Score Test`);
  console.log(`Locale: ${LOCALE} (${LOCALES[LOCALE] || LOCALE})`);
  console.log(`Sample size: ${SAMPLE_SIZE}`);
  console.log(`${'='.repeat(60)}\n`);

  await loadContext();

  // Load random strings
  console.log('Loading random sample...');
  const strings = await loadRandomStrings(SAMPLE_SIZE);
  console.log(`Selected ${strings.length} strings from source files\n`);

  // Translate
  console.log('Translating...');
  const translations = await translateStrings(strings, LOCALE);
  console.log(`Translated ${Object.keys(translations).length} strings\n`);

  // Score
  console.log('Scoring translations...\n');
  const scores = await scoreTranslations(strings, translations, LOCALE);

  // Display results
  console.log('Results:');
  console.log('-'.repeat(60));

  let totalScore = 0;
  let perfect = 0;
  let issues = [];

  for (const result of scores) {
    totalScore += result.score;
    if (result.score === 100) perfect++;

    const status = result.score === 100 ? '✓' : result.score >= 80 ? '○' : '✗';
    console.log(`${status} [${result.score}] "${result.original.substring(0, 40)}${result.original.length > 40 ? '...' : ''}"`);

    if (result.score < 100) {
      console.log(`   → "${result.translated}"`);
      console.log(`   ← "${result.back_translated}"`);
      if (result.issues && result.issues.length > 0) {
        for (const issue of result.issues) {
          console.log(`   ⚠ ${issue}`);
          issues.push({ original: result.original, issue });
        }
      }
    }
  }

  const averageScore = Math.round(totalScore / scores.length);

  console.log('\n' + '='.repeat(60));
  console.log(`FINAL SCORE: ${averageScore}/100`);
  console.log(`Perfect translations: ${perfect}/${scores.length} (${Math.round(perfect/scores.length*100)}%)`);
  console.log('='.repeat(60));

  if (issues.length > 0) {
    console.log('\nIssues to address in translation-context.md:');
    const uniqueIssues = [...new Set(issues.map(i => i.issue))];
    for (const issue of uniqueIssues) {
      console.log(`  • ${issue}`);
    }
  }

  // Return score for iteration
  return { averageScore, perfect, total: scores.length, issues };
}

main().catch(console.error);
