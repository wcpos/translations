#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const gettextParser = require('gettext-parser');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const CONCEPTS_PATH = path.join(__dirname, 'translation-concepts.json');

function loadConcepts() {
  return JSON.parse(fs.readFileSync(CONCEPTS_PATH, 'utf8'));
}

function normalizeSourceTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termMatchesSource(source, term) {
  const normalizedSource = normalizeSourceTerm(source);
  const normalizedTerm = normalizeSourceTerm(term);
  if (!normalizedSource || !normalizedTerm) return false;
  if (normalizedSource === normalizedTerm) return true;

  const flexibleTerm = escapeRegExp(normalizedTerm).replace(/\s+/g, '[\\s\\p{P}]+');
  const fullWord = new RegExp(`(^|[^\\p{L}\\p{N}_])${flexibleTerm}($|[^\\p{L}\\p{N}_])`, 'u');
  return fullWord.test(normalizedSource);
}

function matchConcepts(source, concepts = loadConcepts()) {
  const matches = [];
  for (const concept of concepts) {
    if ((concept.source_terms || []).some(term => termMatchesSource(source, term))) {
      matches.push({
        id: concept.id,
        meaning: concept.meaning,
        avoid_meanings: concept.avoid_meanings || [],
        style: concept.style || '',
      });
    }
  }
  return matches;
}

function splitCommentLines(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return list.map(line => line.replace(/^translators:\s*/i, '').trim()).filter(Boolean);
}

function splitReferenceLines(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\s+/);
  return list.map(line => line.trim()).filter(Boolean);
}

function flattenPotEntries(pot) {
  const flattened = [];
  for (const [ctx, entries] of Object.entries(pot.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (!msgid) continue;
      flattened.push({ ctx, msgid, entry });
    }
  }
  return flattened;
}

function inferAreas(references) {
  const areas = new Set();
  for (const reference of references) {
    if (/receipt/i.test(reference)) areas.add('receipt');
    if (/gateway|payment|cash/i.test(reference)) areas.add('payment');
    if (/template/i.test(reference)) areas.add('template editor');
    if (/settings/i.test(reference)) areas.add('settings');
    if (/admin|wp-admin/i.test(reference)) areas.add('admin');
  }
  return [...areas];
}

function nearbyStrings(flattened, index, windowSize = 2) {
  const nearby = [];
  const start = Math.max(0, index - windowSize);
  const end = Math.min(flattened.length - 1, index + windowSize);
  for (let i = start; i <= end; i++) {
    if (i === index) continue;
    nearby.push(flattened[i].msgid);
  }
  return nearby;
}

function riskFor(entryPacket) {
  const reasons = [];
  const words = entryPacket.entry.msgid.trim().split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length <= 2) reasons.push('short standalone label');
  if (entryPacket.concept_hints.length > 0) reasons.push('concept glossary match');
  if (entryPacket.source_usage.areas.some(area => ['receipt', 'payment', 'settings'].includes(area))) {
    reasons.push('receipt/payment/settings source references');
  }
  return {
    level: reasons.length > 0 ? 'high' : 'normal',
    reasons,
  };
}


function entryKey(ctx, msgid) {
  return ctx ? `${ctx}\x04${msgid}` : msgid;
}

function tokenizeSource(value) {
  return normalizeSourceTerm(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function loadExistingPoEntries({ rootDir, locale, domain }) {
  if (!locale) return [];
  const poPath = path.join(rootDir, 'translations/php', locale, `${domain}-${locale}.po`);
  if (!fs.existsSync(poPath)) return [];

  const po = gettextParser.po.parse(fs.readFileSync(poPath));
  const existing = [];
  for (const [ctx, entries] of Object.entries(po.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (!msgid || !entry.msgstr || !entry.msgstr[0]) continue;
      existing.push({
        msgid,
        msgctxt: ctx || null,
        msgstr: Array.isArray(entry.msgstr) ? entry.msgstr[0] : entry.msgstr,
        references: splitReferenceLines(entry.comments && entry.comments.reference),
        concept_ids: matchConcepts(msgid).map(concept => concept.id),
      });
    }
  }
  return existing;
}

function referenceDirectories(references) {
  return new Set(references.map(reference => path.dirname(reference.split(':')[0])));
}

function rankRelatedTranslations(packet, existingEntries) {
  const source = packet.entry.msgid;
  const sourceNorm = normalizeSourceTerm(source);
  const sourceTokens = new Set(tokenizeSource(source));
  const sourceConceptIds = new Set(packet.concept_hints.map(concept => concept.id));
  const sourceReferenceDirs = referenceDirectories(packet.entry.references);

  return existingEntries
    .filter(existing => existing.msgid !== source)
    .map(existing => {
      let score = 0;
      const existingNorm = normalizeSourceTerm(existing.msgid);
      if (existingNorm === sourceNorm) score += 100;
      if (existingNorm.includes(sourceNorm) || sourceNorm.includes(existingNorm)) score += 50;

      const existingTokens = new Set(tokenizeSource(existing.msgid));
      for (const token of sourceTokens) {
        if (existingTokens.has(token)) score += 15;
      }

      for (const conceptId of existing.concept_ids) {
        if (sourceConceptIds.has(conceptId)) score += 20;
      }

      for (const reference of existing.references) {
        if (sourceReferenceDirs.has(path.dirname(reference.split(':')[0]))) score += 10;
      }

      return { existing, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.existing.msgid.localeCompare(b.existing.msgid))
    .slice(0, 10)
    .map(({ existing }) => ({
      msgid: existing.msgid,
      msgctxt: existing.msgctxt,
      msgstr: existing.msgstr,
    }));
}

function buildPhpContextPackets({ rootDir = DEFAULT_ROOT, locale = null, domain }) {
  if (!domain) throw new Error('domain is required');

  const potPath = path.join(rootDir, 'source/php', `${domain}.pot`);
  const pot = gettextParser.po.parse(fs.readFileSync(potPath));
  const flattened = flattenPotEntries(pot);
  const existingEntries = loadExistingPoEntries({ rootDir, locale, domain });
  const entries = flattened.map(({ ctx, msgid, entry }, index) => {
    const translatorComments = splitCommentLines(entry.comments && (entry.comments.translator || entry.comments.extracted));
    const references = splitReferenceLines(entry.comments && entry.comments.reference);
    const packet = {
      project: domain,
      domain,
      format: 'php-po',
      locale,
      entry: {
        msgid,
        msgctxt: ctx || null,
        msgid_plural: entry.msgid_plural || null,
        translator_comments: translatorComments,
        references,
      },
      source_usage: {
        areas: inferAreas(references),
        nearby_source_strings: nearbyStrings(flattened, index),
      },
      related_existing_translations: [],
      concept_hints: matchConcepts(msgid),
      risk: { level: 'normal', reasons: [] },
    };
    packet.related_existing_translations = rankRelatedTranslations(packet, existingEntries);
    packet.risk = riskFor(packet);
    return packet;
  });

  return {
    project: domain,
    domain,
    format: 'php-po',
    locale,
    entries,
  };
}


function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.type !== 'php') {
    throw new Error('Only --type php is currently supported');
  }
  const rootDir = args.rootDir ? path.resolve(args.rootDir) : DEFAULT_ROOT;
  const outDir = path.resolve(rootDir, args.outDir || 'translation-context/php');
  const packets = buildPhpContextPackets({ rootDir, locale: args.locale || null, domain: args.domain });
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${args.domain}.context.json`);
  fs.writeFileSync(outPath, JSON.stringify(packets, null, 2) + '\n');
  process.stdout.write(`${outPath}\n`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  buildPhpContextPackets,
  matchConcepts,
  normalizeSourceTerm,
  runCli,
};
