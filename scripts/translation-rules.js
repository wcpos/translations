let glossaryCache;
let localeRulesCache;
let englishRulesCache;

// Match standalone decimals, excluding version strings such as v2.0.1.
const DECIMAL_NUMBER_RE = /(?<![.\w])\d+\.\d+(?![\d.])/;

function normalizeWcposProductNames(value) {
  return value
    .replace(/\bWooCommerce POS Pro\b/g, 'WCPOS Pro')
    .replace(/\bWooCommerce POS\b/g, 'WCPOS');
}

function extractPlaceholders(text) {
  // Consume double braces and printf arguments before their shorter alternatives.
  // The digit guard prevents backtracking into part of a positional argument.
  return (text.match(/\{\{[^{}]+\}\}|\{[^{}]+\}|%(?:\d+\$[sdfu]|[sdfu%]|\d+(?![\d$]))/g) || []).sort();
}

function extractMarkupTags(text) {
  const tags = text.matchAll(/<(\/?[A-Za-z][\w:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/g);
  return Array.from(tags, match => match[1]).sort();
}

function checkTranslation({ locale, source, translation }) {
  const errors = [];
  const warnings = [];

  if (translation.trim() === '') errors.push('Translation is empty');
  if (JSON.stringify(extractPlaceholders(source)) !== JSON.stringify(extractPlaceholders(translation))) {
    errors.push('Placeholder mismatch between source and translation');
  }
  if (JSON.stringify(extractMarkupTags(source)) !== JSON.stringify(extractMarkupTags(translation))) {
    errors.push('Markup mismatch between source and translation');
  }
  if (translation.includes('WooCommerce POS')) {
    errors.push('Use "WCPOS" instead of "WooCommerce POS"');
  }

  glossaryCache ??= require('./translation-glossary.json');
  const terms = glossaryCache[locale] ?? glossaryCache[locale.split('_')[0]];
  for (const [englishTerm, requiredTerm] of Object.entries(terms || {})) {
    const escapedEnglish = englishTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sourceRe = new RegExp(`\\b${escapedEnglish}\\b`, 'i');
    if (!sourceRe.test(source)) continue;
    const escapedRequired = requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(escapedRequired, 'i').test(translation)) {
      warnings.push(`"${englishTerm}" should be translated as "${requiredTerm}" for ${locale}`);
    }
  }

  localeRulesCache ??= require('./locale-rules.json');
  const rule = localeRulesCache[locale] ?? localeRulesCache[locale.split('_')[0]];
  if (rule) {
    if (rule.decimal_separator && rule.decimal_separator !== '.' &&
        DECIMAL_NUMBER_RE.test(source) && DECIMAL_NUMBER_RE.test(translation)) {
      warnings.push(`Decimal separator should be '${rule.decimal_separator}' for locale ${locale} but translation uses '.'`);
    }
    for (const { pattern, reason } of rule.forbidden_patterns || []) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      if (re.test(translation)) {
        warnings.push(`Forbidden pattern /${pattern}/ matched in translation: ${reason}`);
      }
    }
  }

  return { errors, warnings };
}

function checkEnglishSource(source, variant) {
  englishRulesCache ??= require('./english-rules.json');
  const rules = englishRulesCache[variant];
  if (!rules) return [];
  const warnings = [];

  for (const { wrong, right, reason } of rules.spelling || []) {
    let re;
    try {
      re = new RegExp(wrong, 'i');
    } catch {
      continue;
    }
    if (re.test(source)) {
      warnings.push(`Spelling: use "${right}" not the matched form (${reason})`);
    }
  }
  for (const { pattern, reason } of rules.style || []) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      continue;
    }
    if (re.test(source)) warnings.push(`Style: ${reason}`);
  }

  return warnings;
}

module.exports = {
  normalizeWcposProductNames,
  extractPlaceholders,
  extractMarkupTags,
  checkTranslation,
  checkEnglishSource,
};
