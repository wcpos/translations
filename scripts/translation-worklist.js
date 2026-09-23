#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { expectedKeysForLocale, parsePluralKey } = require('./plural-rules');
const {
  parsePoFile, mergePoEntries, parsePluralSlotCount, getPhpPluralForms, ensurePoHeader,
} = require('./po-file');
const { matchConcepts } = require('./translation-context-packets');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const ENGLISH_LOCALES = new Set(['en', 'en_US', 'en_GB']);

function buildWorklist({ rootDir = DEFAULT_ROOT, locales = null } = {}) {
  const localeNames = JSON.parse(fs.readFileSync(path.join(rootDir, 'locales.json'), 'utf8'));
  for (const locale of locales ?? []) {
    if (!Object.hasOwn(localeNames, locale)) throw new Error(`Unknown locale: ${locale}`);
  }
  // This module reads process.argv on import; CLI arguments must be validated first.
  const { sourceTextForTranslationKey } = require('./check-completeness');
  const glossary = JSON.parse(fs.readFileSync(path.join(rootDir, 'scripts/translation-glossary.json'), 'utf8'));
  delete glossary._comment;
  const jsDir = path.join(rootDir, 'source/js');
  const jsFiles = fs.readdirSync(jsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(project => fs.readdirSync(path.join(jsDir, project.name))
      .filter(file => file.endsWith('.json')).map(file => `${project.name}/${file}`))
    .sort();
  const phpDir = path.join(rootDir, 'source/php');
  const potFiles = fs.readdirSync(phpDir).filter(file => file.endsWith('.pot')).sort();
  const packets = [];
  let total = 0;

  for (const [locale, localeName] of Object.entries(localeNames)) {
    if (ENGLISH_LOCALES.has(locale) || (locales !== null && !locales.includes(locale))) continue;
    const language = locale.split('_')[0];
    const notes = [locale, language].map(code => `scripts/locale-context/${code}.md`)
      .find(file => fs.existsSync(path.join(rootDir, file))) ?? null;
    const packet = {
      locale, locale_name: localeName, locale_notes: notes,
      glossary: glossary[locale] ?? glossary[language] ?? {},
      counts: { js: 0, php: 0 }, js: {}, php: {},
    };

    for (const file of jsFiles) {
      const sourceStrings = JSON.parse(fs.readFileSync(path.join(jsDir, file), 'utf8'));
      const translationPath = path.join(rootDir, 'translations/js', locale, file);
      const translations = fs.existsSync(translationPath)
        ? JSON.parse(fs.readFileSync(translationPath, 'utf8')) : {};
      const missing = {};
      for (const key of expectedKeysForLocale(Object.keys(sourceStrings), locale)) {
        if (key in translations) continue;
        const source = sourceTextForTranslationKey(sourceStrings, key);
        const plural = parsePluralKey(key);
        missing[key] = {
          source,
          ...(plural ? { plural_category: plural.suffix } : {}),
          concepts: matchConcepts(source),
        };
        packet.counts.js++;
      }
      if (Object.keys(missing).length) packet.js[file] = missing;
    }

    for (const file of potFiles) {
      const domain = file.slice(0, -4);
      const pot = parsePoFile(fs.readFileSync(path.join(phpDir, file), 'utf8'));
      const poPath = path.join(rootDir, 'translations/php', locale, `${domain}-${locale}.po`);
      const existing = fs.existsSync(poPath)
        ? parsePoFile(fs.readFileSync(poPath, 'utf8')) : { header: '', entries: [] };
      const header = ensurePoHeader(existing.header, domain, locale);
      const pluralForms = getPhpPluralForms(locale);
      const slots = parsePluralSlotCount(header) ?? pluralForms.nplurals;
      const { untranslated } = mergePoEntries(pot.entries, existing.entries, slots);
      if (!untranslated.length) continue;
      packet.php[domain] = {
        nplurals: slots,
        plural_expression: pluralForms.expression,
        entries: untranslated.map(({ entry }) => ({
          id: `p${++packet.counts.php}`,
          ...(entry.msgctxt !== undefined ? { msgctxt: entry.msgctxt } : {}),
          msgid: entry.msgid,
          ...(entry.msgid_plural !== undefined ? { msgid_plural: entry.msgid_plural } : {}),
          forms: entry.msgid_plural !== undefined ? slots : 1,
          translator_notes: entry.comments.filter(line => line.startsWith('#.'))
            .map(line => line.slice(2).trim().replace(/^translators:\s*/i, '').trim()).filter(Boolean),
          references: entry.comments.filter(line => line.startsWith('#:'))
            .flatMap(line => line.slice(2).trim().split(/\s+/)).filter(Boolean),
          concepts: matchConcepts(entry.msgid),
        })),
      };
    }

    if (packet.counts.js + packet.counts.php > 0) {
      packets.push(packet);
      total += packet.counts.js + packet.counts.php;
    }
  }
  return { total, packets };
}

function runCli(argv) {
  const args = { locales: null };
  let outDir;
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (!['--out', '--locale', '--root'].includes(option)) {
      throw new Error(`Unknown argument: ${option}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
    if (option === '--out') outDir = path.resolve(value);
    if (option === '--root') args.rootDir = path.resolve(value);
    if (option === '--locale') (args.locales ??= []).push(value);
  }
  if (!outDir) throw new Error('--out is required');
  const { total, packets } = buildWorklist(args);
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith('.json')) fs.unlinkSync(path.join(outDir, file));
  }
  const locales = {};
  for (const packet of packets) {
    fs.writeFileSync(path.join(outDir, `${packet.locale}.json`), JSON.stringify(packet, null, 2) + '\n');
    locales[packet.locale] = packet.counts;
  }
  process.stdout.write(JSON.stringify({ total, locales }) + '\n');
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { buildWorklist };
