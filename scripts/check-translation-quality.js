#!/usr/bin/env node

/**
 * Heuristic translation quality smoke checks.
 *
 * This is not a substitute for native review. It catches recurring patterns from
 * Aide spot checks so future translation batches can be reviewed faster.
 *
 * Usage:
 *   node scripts/check-translation-quality.js [--locale de_DE] [--changed-since origin/main] [--json] [--markdown] [--github-annotations]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gettextParser = require('gettext-parser');
const { parsePluralKey, pluralBasesOf } = require('./plural-rules');

const ROOT = path.resolve(__dirname, '..');
const ENGLISH_LOCALES = new Set(['en', 'en_US', 'en_GB']);

const ALWAYS_ENGLISH = new Set([
  'POS', 'OK', 'ID', 'SKU', 'API', 'REST API', 'JSON', 'PHP', 'CSS', 'HTML', 'URL', 'UUID',
  'WCPOS', 'WCPOS Pro', 'WooCommerce', 'WordPress', 'Stripe', 'PayPal', 'Square',
  'Gateway', 'Gateway ID', 'Barcode', 'QR Code', 'Debug', 'Error', 'Warning', 'Admin',
  'Plugin', 'Theme', 'Online', 'Offline', 'N/A', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY',
  // Country-specific receipt/tax ID labels intentionally stay in their local form.
  'Codice Fiscale', 'Partita IVA', 'P.IVA', 'USt-IdNr.', 'Steuernummer',
  'CPF', 'CNPJ', 'GSTIN', 'NIF', 'CUIT', 'GST/HST', 'GST/HST No.', 'EIN', 'HRB', 'KVK',
  // Technical/proper-noun receipt labels that are intentionally unchanged.
  'kilbot', 'SKU: %s', 'POS & Online', 'HTML (Offline)', 'PHP (Legacy)',
]);

function isAllowedUnchangedTechnicalString(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (ALWAYS_ENGLISH.has(trimmed)) return true;
  if (/^(?:%\d+\$[sdfb]|%[sdfb]|[\s:().,/-])+$/i.test(trimmed)) return true;
  if (/^https?:\/\//.test(trimmed)) return true;
  if (/^[\w.-]+@[\w.-]+$/.test(trimmed)) return true;
  if (/^[a-z0-9]+[._-][a-z0-9._-]+$/.test(trimmed) && trimmed.length <= 32) return true;
  if (/^[A-Z0-9_/%$#.: -]+$/.test(trimmed) && trimmed.length <= 16) return true;
  return false;
}

function hasGreekTitleCase(value) {
  const words = String(value).trim().split(/\s+/).filter(Boolean);
  const greekCapitalized = words.filter((word) => /^[Α-ΩΆΈΉΊΌΎΏ][α-ωάέήίόύώϊϋΐΰ]+/.test(word));
  return greekCapitalized.length >= 2;
}

function isShortUiLabel(msgid) {
  const value = String(msgid || '').trim();
  if (!value || /[.!?]/.test(value)) return false;
  return value.split(/\s+/).length <= 4;
}

function findQualityWarnings({ locale, msgid, msgstr }) {
  const warnings = [];
  const value = Array.isArray(msgstr) ? msgstr.join(' | ') : String(msgstr || '');
  const normalizedLocale = String(locale || '');

  if (!ENGLISH_LOCALES.has(normalizedLocale) && value.trim() === String(msgid || '').trim() && !isAllowedUnchangedTechnicalString(value)) {
    warnings.push('human-facing English appears unchanged');
  }

  if (/^de(_|$)/.test(normalizedLocale) && /manuell an %s von WCPOS gesendet/.test(value)) {
    warnings.push('German phrasing is too literal; prefer natural verb placement such as "wurden von WCPOS manuell an %s gesendet"');
  }

  if (/^bg(_|$)/.test(normalizedLocale) && /ръчно изпратени/.test(value) && !/(^|\s)(са|бяха)(\s|$)/u.test(value)) {
    warnings.push('Bulgarian passive phrasing appears to be missing an auxiliary verb');
  }

  if (/^el($|_)/.test(normalizedLocale) && isShortUiLabel(msgid) && hasGreekTitleCase(value) && !/^[A-Z0-9_ -]+$/.test(String(msgid || ''))) {
    warnings.push('Greek UI labels should normally use sentence case, not English-style title case');
  }

  if (/WooCommerce POS/.test(value)) {
    warnings.push('customer-facing product name should use WCPOS / WCPOS Pro, not WooCommerce POS');
  }

  return warnings;
}

function parseArgs(argv) {
  const options = { locale: '', changedSince: '', json: false, markdown: false, githubAnnotations: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--github-annotations') options.githubAnnotations = true;
    else if (arg === '--locale') options.locale = argv[++i] || '';
    else if (arg === '--changed-since') options.changedSince = argv[++i] || '';
  }
  const outputModes = [options.json, options.markdown, options.githubAnnotations].filter(Boolean).length;
  if (outputModes > 1) {
    throw new Error('Choose only one output mode: --json, --markdown, or --github-annotations');
  }
  return options;
}

function normalizePathSeparators(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isChangedRelativePath(changed, relativePath) {
  return !changed || changed.has(normalizePathSeparators(relativePath));
}

function changedTranslationFiles(ref, root = ROOT) {
  if (!ref) return null;
  try {
    const changed = execFileSync('git', ['diff', '--name-only', ref, '--', 'translations/php', 'translations/js'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map(normalizePathSeparators)
      .filter((file) => file.endsWith('.po') || file.endsWith('.json'));
    return new Set(changed);
  } catch (error) {
    throw new Error(`Unable to list changed translation files since ${ref}: ${error.message}`);
  }
}

function scanPoFile(filePath, locale) {
  const relPath = path.relative(ROOT, filePath);
  const warnings = [];
  const po = gettextParser.po.parse(fs.readFileSync(filePath));

  for (const [context, entries] of Object.entries(po.translations || {})) {
    for (const [msgid, entry] of Object.entries(entries || {})) {
      if (!msgid) continue;
      const forms = entry.msgstr || [];
      for (let index = 0; index < forms.length; index += 1) {
        const msgstr = forms[index];
        if (!msgstr || !msgstr.trim()) continue;
        const sourceMsgid = index > 0 && entry.msgid_plural ? entry.msgid_plural : msgid;
        for (const warning of findQualityWarnings({ locale, msgid: sourceMsgid, msgstr })) {
          warnings.push({ file: relPath, locale, msgid: sourceMsgid, context, form: index, msgstr, warning });
        }
      }
    }
  }

  return warnings;
}


function resolveJsonSourceText(key, source) {
  if (typeof source[key] === 'string') return source[key];

  const plural = parsePluralKey(key);
  if (!plural) return key;

  const otherKey = `${plural.base}_other`;
  if (typeof source[otherKey] === 'string') return source[otherKey];

  for (const [sourceKey, sourceText] of Object.entries(source || {})) {
    const sourcePlural = parsePluralKey(sourceKey);
    if (sourcePlural && sourcePlural.base === plural.base && typeof sourceText === 'string') {
      return sourceText;
    }
  }

  return key;
}

function scanJsonTranslations({ file, locale, translations, source = {} }) {
  const warnings = [];
  for (const [key, value] of Object.entries(translations || {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const sourceText = resolveJsonSourceText(key, source);
    for (const warning of findQualityWarnings({ locale, msgid: sourceText, msgstr: value })) {
      warnings.push({ file, locale, key, msgid: sourceText, context: '', form: 0, msgstr: value, warning });
    }
  }
  return warnings;
}

function resolveJsonSourcePath(relPath, locale, root = ROOT) {
  const prefix = `translations/js/${locale}/`;
  if (!relPath.startsWith(prefix)) return '';
  return path.join(root, 'source/js', relPath.slice(prefix.length));
}

function scanJsonFile(filePath, locale) {
  const relPath = path.relative(ROOT, filePath);
  const translations = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const sourcePath = resolveJsonSourcePath(relPath, locale);
  const source = sourcePath && fs.existsSync(sourcePath)
    ? JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
    : {};
  return scanJsonTranslations({ file: relPath, locale, translations, source });
}

function discoverTranslationFiles({ locale, changedSince, root = ROOT }) {
  const changed = changedTranslationFiles(changedSince, root);
  const phpTranslationsDir = path.join(root, 'translations/php');
  const jsTranslationsDir = path.join(root, 'translations/js');
  const locales = locale
    ? [locale]
    : fs.readdirSync(phpTranslationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const files = [];

  for (const code of locales) {
    const phpDir = path.join(phpTranslationsDir, code);
    if (fs.existsSync(phpDir)) {
      for (const file of fs.readdirSync(phpDir)) {
        if (!file.endsWith('.po')) continue;
        const absolute = path.join(phpDir, file);
        const relative = path.relative(root, absolute);
        if (!isChangedRelativePath(changed, relative)) continue;
        files.push({ file: absolute, locale: code, type: 'po' });
      }
    }

    const jsDir = path.join(jsTranslationsDir, code);
    if (fs.existsSync(jsDir)) {
      const stack = [jsDir];
      while (stack.length > 0) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(absolute);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const relative = path.relative(root, absolute);
          if (!isChangedRelativePath(changed, relative)) continue;
          files.push({ file: absolute, locale: code, type: 'json' });
        }
      }
    }
  }

  return files;
}

// Thresholds from the 2026-11-22 Fable translations review (section 6 item 6): short
// labels that grew far past their source, and one English source translated several
// ways within a locale.
const SHORT_SOURCE_MAX_GRAPHEMES = 9;
const LENGTH_BUDGET_SLACK = 6;
const WIDE_LOCALE_RE = /^(?:ja|zh|ko)(?:_|$)/;
const DRIFT_SOURCE_MAX_CHARS = 60;
const DRIFT_MESSAGE_MAX_CHARS = 300;
// i18next {var} / {{var}} and printf %s, %d, %1$s.
const PLACEHOLDER_RE = /\{[^}]+\}|%(?:\d+\$)?[sdfbu]/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Wide (double-width) blocks: Hangul Jamo, CJK radicals and symbols/punctuation, Hiragana,
// Katakana, Hangul compatibility Jamo, Katakana extension, CJK ideographs (ext. A, unified),
// Hangul syllables, CJK compatibility ideographs, fullwidth forms, CJK ext. B and later.
const WIDE_RANGES = [
  [0x1100, 0x11ff], [0x2e80, 0x303f], [0x3040, 0x30ff], [0x3130, 0x318f], [0x31f0, 0x31ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff],
  [0xff01, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3ffff],
];

function graphemes(value) {
  return [...graphemeSegmenter.segment(String(value || '').trim())].map((part) => part.segment);
}

function isWideGrapheme(grapheme) {
  const code = grapheme.codePointAt(0);
  return WIDE_RANGES.some(([start, end]) => code >= start && code <= end);
}

function findLengthBudgetWarning({ locale, msgid, msgstr }) {
  const source = String(msgid || '').trim();
  const translation = String(msgstr || '').trim();
  if (!source || !translation || PLACEHOLDER_RE.test(source) || PLACEHOLDER_RE.test(translation)) return '';
  const sourceLength = graphemes(source).length;
  if (sourceLength > SHORT_SOURCE_MAX_GRAPHEMES) return '';
  const wide = WIDE_LOCALE_RE.test(String(locale || ''));
  const parts = graphemes(translation);
  const length = wide ? parts.reduce((sum, part) => sum + (isWideGrapheme(part) ? 2 : 1), 0) : parts.length;
  const budget = wide ? 2 * sourceLength : sourceLength + LENGTH_BUDGET_SLACK;
  if (length <= budget) return '';
  return `Too long for a short label: "${source}" (${sourceLength}) → "${translation}" (${length}), budget ${budget}`;
}

/** Singular, non-empty entries of one PO or JSON file's content; plural entries and stale JSON keys are skipped. */
function readSingularEntries(type, content, sourceStrings, relPath) {
  if (type === 'po') {
    const entries = [];
    for (const [context, byId] of Object.entries(gettextParser.po.parse(content).translations || {})) {
      for (const [msgid, entry] of Object.entries(byId || {})) {
        const translation = String((entry.msgstr || [])[0] || '').trim();
        if (!msgid || entry.msgid_plural || !translation) continue;
        const label = context ? `${path.basename(relPath)} ${context}` : path.basename(relPath);
        entries.push({ id: `${context}\u0004${msgid}`, label, source: msgid, translation });
      }
    }
    return entries;
  }
  const bases = pluralBasesOf(Object.keys(sourceStrings));
  return Object.entries(JSON.parse(String(content)) || {})
    .filter(([key, value]) => {
      const plural = parsePluralKey(key);
      return typeof value === 'string' && value.trim() && typeof sourceStrings[key] === 'string'
        && !(plural && bases.has(plural.base));
    })
    .map(([key, value]) => ({ id: key, label: key, source: sourceStrings[key], translation: value.trim() }));
}

function readFileAtRef(ref, relPath, root) {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null; // Missing at the ref: everything in the file is new.
  }
}

/**
 * Length-budget and same-source-drift warnings. Drift groups span every file of a locale;
 * with changedSince only entries new or changed since that ref (and drift groups holding one) warn.
 */
function findConsistencyWarnings({ locale, changedSince, root = ROOT }) {
  const changed = changedTranslationFiles(changedSince, root);
  const changedLocales = changed && new Set([...changed].map((file) => file.split('/')[2]));
  const warnings = [];
  const groups = new Map();

  for (const { file, locale: code, type } of discoverTranslationFiles({ locale, root })) {
    if (changedLocales && !changedLocales.has(code)) continue;
    const relPath = normalizePathSeparators(path.relative(root, file));
    const sourcePath = type === 'json' ? resolveJsonSourcePath(relPath, code, root) : '';
    const sourceStrings = sourcePath && fs.existsSync(sourcePath) ? JSON.parse(fs.readFileSync(sourcePath, 'utf8')) : {};
    let oldValues = null;
    if (changed && changed.has(relPath)) {
      const old = readFileAtRef(changedSince, relPath, root);
      oldValues = new Map(old ? readSingularEntries(type, old, sourceStrings, relPath).map((e) => [e.id, e.translation]) : []);
    }

    for (const entry of readSingularEntries(type, fs.readFileSync(file), sourceStrings, relPath)) {
      const isNew = !changed || (oldValues !== null && oldValues.get(entry.id) !== entry.translation);
      const lengthWarning = isNew && findLengthBudgetWarning({ locale: code, msgid: entry.source, msgstr: entry.translation });
      if (lengthWarning) {
        warnings.push({ file: relPath, locale: code, key: entry.label, msgid: entry.source, context: '', form: 0,
          msgstr: entry.translation, warning: lengthWarning, category: 'length-budget' });
      }
      const source = entry.source.trim();
      if (!source || source.length > DRIFT_SOURCE_MAX_CHARS || PLACEHOLDER_RE.test(source)) continue;
      const groupKey = `${code}\u0004${source}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { locale: code, source, entries: [] });
      groups.get(groupKey).entries.push({ ...entry, file: relPath, isNew });
    }
  }

  for (const group of groups.values()) {
    const representative = group.entries.find((entry) => entry.isNew);
    if (!representative) continue;
    const variants = new Map();
    for (const entry of group.entries) {
      if (!variants.has(entry.translation)) variants.set(entry.translation, []);
      variants.get(entry.translation).push(entry);
    }
    if (variants.size < 2) continue;
    const parts = [...variants].map(([translation, entries]) => (
      `"${translation}" (${entries[0].label}${entries.length > 1 ? `, +${entries.length - 1} more` : ''})`));
    const message = truncateForSummary(`Same English, different translations: "${group.source}" → ${parts.join(' | ')}`, DRIFT_MESSAGE_MAX_CHARS);
    warnings.push({ file: representative.file, locale: group.locale, key: representative.label, msgid: group.source, context: '',
      form: 0, msgstr: [...variants.keys()].join(' | '), warning: message, category: 'same-source-drift' });
  }

  return warnings;
}


function truncateForSummary(value, maxLength = 140) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatMarkdownSummary(warnings, { limit = 25 } = {}) {
  const items = Array.isArray(warnings) ? warnings : [];
  if (items.length === 0) {
    return '## Translation quality smoke check\n\nNo warnings found.';
  }

  const lines = [
    '## Translation quality smoke check',
    '',
    `${items.length} warning(s) found. This check is warning-only; investigate warnings before merging translation changes.`,
    '',
  ];
  const counts = new Map();
  for (const item of items) counts.set(item.category || 'heuristic', (counts.get(item.category || 'heuristic') || 0) + 1);
  lines.push(`By category: ${[...counts].map(([category, count]) => `${category} ${count}`).join(', ')}`, '');

  for (const item of items.slice(0, limit)) {
    lines.push(`- **${item.warning}**`);
    lines.push(`  - File: \`${item.file}\``);
    lines.push(`  - Source: ${truncateForSummary(item.msgid)}`);
    lines.push(`  - Translation: ${truncateForSummary(item.msgstr)}`);
  }

  if (items.length > limit) {
    lines.push('', `... ${items.length - limit} more warning(s).`);
  }

  return lines.join('\n');
}


function escapeGithubAnnotationValue(value) {
  return String(value || '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function formatGithubAnnotations(warnings, { limit = 50 } = {}) {
  const items = Array.isArray(warnings) ? warnings : [];
  return items.slice(0, limit).map((item) => {
    const file = escapeGithubAnnotationValue(item.file);
    const message = escapeGithubAnnotationValue(`${item.warning}: ${truncateForSummary(item.msgid)} => ${truncateForSummary(item.msgstr)}`);
    return `::warning file=${file},title=Translation quality::${message}`;
  }).join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const warnings = [];
  for (const { file, locale, type } of discoverTranslationFiles(options)) {
    warnings.push(...(type === 'json' ? scanJsonFile(file, locale) : scanPoFile(file, locale)));
  }
  warnings.push(...findConsistencyWarnings(options));

  if (options.json) {
    console.log(JSON.stringify({ warnings: warnings.length, details: warnings }, null, 2));
  } else if (options.markdown) {
    console.log(formatMarkdownSummary(warnings));
  } else if (options.githubAnnotations) {
    const annotations = formatGithubAnnotations(warnings);
    if (annotations) console.log(annotations);
  } else {
    console.log(`Translation quality smoke check: ${warnings.length} warning(s)`);
    for (const item of warnings.slice(0, 50)) {
      console.log(`WARN ${item.file}: ${item.msgid} => ${item.msgstr}`);
      console.log(`  ${item.warning}`);
    }
    if (warnings.length > 50) console.log(`... ${warnings.length - 50} more warning(s)`);
  }

  return warnings;
}

module.exports = {
  findConsistencyWarnings,
  findLengthBudgetWarning,
  findQualityWarnings,
  formatGithubAnnotations,
  formatMarkdownSummary,
  isAllowedUnchangedTechnicalString,
  isChangedRelativePath,
  isShortUiLabel,
  normalizePathSeparators,
  scanPoFile,
  resolveJsonSourceText,
  scanJsonTranslations,
  scanJsonFile,
  resolveJsonSourcePath,
  main,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
