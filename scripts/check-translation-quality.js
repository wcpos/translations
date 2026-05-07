#!/usr/bin/env node

/**
 * Heuristic translation quality smoke checks.
 *
 * This is not a substitute for native review. It catches recurring patterns from
 * Aide spot checks so future translation batches can be reviewed faster.
 *
 * Usage:
 *   node scripts/check-translation-quality.js [--locale de_DE] [--changed-since origin/main] [--json] [--markdown]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gettextParser = require('gettext-parser');
const { parsePluralKey } = require('./plural-rules');

const ROOT = path.resolve(__dirname, '..');
const PHP_TRANSLATIONS_DIR = path.join(ROOT, 'translations/php');
const JS_TRANSLATIONS_DIR = path.join(ROOT, 'translations/js');
const ENGLISH_LOCALES = new Set(['en', 'en_US', 'en_GB']);

const ALWAYS_ENGLISH = new Set([
  'POS', 'OK', 'ID', 'SKU', 'API', 'REST API', 'JSON', 'PHP', 'CSS', 'HTML', 'URL', 'UUID',
  'WCPOS', 'WCPOS Pro', 'WooCommerce', 'WordPress', 'Stripe', 'PayPal', 'Square',
  'Gateway', 'Gateway ID', 'Barcode', 'QR Code', 'Debug', 'Error', 'Warning', 'Admin',
  'Plugin', 'Theme', 'Online', 'Offline', 'N/A', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY',
]);

function isAllowedUnchangedTechnicalString(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (ALWAYS_ENGLISH.has(trimmed)) return true;
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
  const options = { locale: '', changedSince: '', json: false, markdown: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--locale') options.locale = argv[++i] || '';
    else if (arg === '--changed-since') options.changedSince = argv[++i] || '';
  }
  return options;
}

function normalizePathSeparators(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isChangedRelativePath(changed, relativePath) {
  return !changed || changed.has(normalizePathSeparators(relativePath));
}

function changedTranslationFiles(ref) {
  if (!ref) return null;
  try {
    const changed = execFileSync('git', ['diff', '--name-only', ref, '--', 'translations/php', 'translations/js'], {
      cwd: ROOT,
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

function resolveJsonSourcePath(relPath, locale) {
  const prefix = `translations/js/${locale}/`;
  if (!relPath.startsWith(prefix)) return '';
  return path.join(ROOT, 'source/js', relPath.slice(prefix.length));
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

function discoverTranslationFiles({ locale, changedSince }) {
  const changed = changedTranslationFiles(changedSince);
  const locales = locale
    ? [locale]
    : fs.readdirSync(PHP_TRANSLATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const files = [];

  for (const code of locales) {
    const phpDir = path.join(PHP_TRANSLATIONS_DIR, code);
    if (fs.existsSync(phpDir)) {
      for (const file of fs.readdirSync(phpDir)) {
        if (!file.endsWith('.po')) continue;
        const absolute = path.join(phpDir, file);
        const relative = path.relative(ROOT, absolute);
        if (!isChangedRelativePath(changed, relative)) continue;
        files.push({ file: absolute, locale: code, type: 'po' });
      }
    }

    const jsDir = path.join(JS_TRANSLATIONS_DIR, code);
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
          const relative = path.relative(ROOT, absolute);
          if (!isChangedRelativePath(changed, relative)) continue;
          files.push({ file: absolute, locale: code, type: 'json' });
        }
      }
    }
  }

  return files;
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

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const warnings = [];
  for (const { file, locale, type } of discoverTranslationFiles(options)) {
    warnings.push(...(type === 'json' ? scanJsonFile(file, locale) : scanPoFile(file, locale)));
  }

  if (options.json) {
    console.log(JSON.stringify({ warnings: warnings.length, details: warnings }, null, 2));
  } else if (options.markdown) {
    console.log(formatMarkdownSummary(warnings));
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
  findQualityWarnings,
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
