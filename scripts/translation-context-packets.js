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

  const flexibleTerm = escapeRegExp(normalizedTerm).replace(/\\\s\+/g, '[\\s\\p{P}]+');
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

function buildPhpContextPackets({ rootDir = DEFAULT_ROOT, locale = null, domain }) {
  if (!domain) throw new Error('domain is required');

  const potPath = path.join(rootDir, 'source/php', `${domain}.pot`);
  const pot = gettextParser.po.parse(fs.readFileSync(potPath));
  const flattened = flattenPotEntries(pot);
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

module.exports = {
  buildPhpContextPackets,
  matchConcepts,
  normalizeSourceTerm,
};
