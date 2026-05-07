/**
 * CLDR plural rules for i18next.
 *
 * Single source of truth — imported by translate-locale.js,
 * check-completeness.js, and cleanup-stale-keys.js.
 */

/** i18next plural suffixes per locale based on CLDR plural rules. */
const PLURAL_SUFFIXES = {
  // East Asian (no plural forms — just "other")
  ja: ['other'],
  km: ['other'],
  zh: ['other'],
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
  fr: ['one', 'many', 'other'],
  fr_FR: ['one', 'many', 'other'],
  fr_CA: ['one', 'many', 'other'],
  es: ['one', 'many', 'other'],
  es_ES: ['one', 'many', 'other'],
  es_MX: ['one', 'many', 'other'],
  es_AR: ['one', 'many', 'other'],
  it_IT: ['one', 'many', 'other'],
  pt: ['one', 'many', 'other'],
  pt_BR: ['one', 'many', 'other'],
  pt_PT: ['one', 'many', 'other'],
  sv_SE: ['one', 'other'],
  da: ['one', 'other'],
  nb_NO: ['one', 'other'],
  el: ['one', 'other'],
  he_IL: ['one', 'two', 'other'],
  hi_IN: ['one', 'other'],
  hu_HU: ['one', 'other'],
  tr_TR: ['one', 'other'],
  fa_IR: ['one', 'other'],
  bg_BG: ['one', 'other'],
  ca_ES: ['one', 'many', 'other'],
  et: ['one', 'other'],
  fi: ['one', 'other'],
  is_IS: ['one', 'other'],
  lt_LT: ['one', 'few', 'many', 'other'],
  mk_MK: ['one', 'other'],

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

/** Default for unknown locales. */
const DEFAULT_PLURAL_SUFFIXES = ['one', 'other'];

/** All possible CLDR plural suffixes. */
const ALL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** Regex matching a plural key: captures (base, suffix). */
const SUFFIX_RE = new RegExp(`^(.+)_(${ALL_SUFFIXES.join('|')})$`);

/**
 * Return the plural suffixes required by a locale.
 * Falls back to DEFAULT_PLURAL_SUFFIXES for unknown locales.
 */
function getPluralSuffixes(locale) {
  return PLURAL_SUFFIXES[locale] || DEFAULT_PLURAL_SUFFIXES;
}

/**
 * Parse a key into base + plural suffix.
 * Returns { base, suffix } or null if not a plural key.
 */
function parsePluralKey(key) {
  const m = key.match(SUFFIX_RE);
  return m ? { base: m[1], suffix: m[2] } : null;
}

/**
 * Compute the set of expected keys for a given locale.
 * Plural keys are expanded to only the suffixes required by that locale.
 */
function expectedKeysForLocale(sourceKeys, locale) {
  const suffixes = getPluralSuffixes(locale);

  // Identify plural base keys in source
  const pluralBases = new Set();
  for (const k of sourceKeys) {
    const m = k.match(SUFFIX_RE);
    if (m) pluralBases.add(m[1]);
  }

  const expected = new Set();
  for (const k of sourceKeys) {
    const m = k.match(SUFFIX_RE);
    if (m && pluralBases.has(m[1])) {
      if (suffixes.includes(m[2])) expected.add(k);
    } else {
      expected.add(k);
    }
  }
  // Add locale-specific plural forms that may not be in source
  for (const base of pluralBases) {
    for (const s of suffixes) {
      expected.add(`${base}_${s}`);
    }
  }
  return expected;
}

module.exports = {
  PLURAL_SUFFIXES,
  DEFAULT_PLURAL_SUFFIXES,
  ALL_SUFFIXES,
  SUFFIX_RE,
  getPluralSuffixes,
  parsePluralKey,
  expectedKeysForLocale,
};
