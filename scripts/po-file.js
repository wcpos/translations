const PHP_PLURAL_FORMS = {
  ar: { nplurals: 6, expression: 'n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 && n%100<=99 ? 4 : 5' },
  cs: { nplurals: 3, expression: 'n==1 ? 0 : n>=2 && n<=4 ? 1 : 2' },
  he_IL: { nplurals: 4, expression: 'n==1 ? 0 : n==2 ? 1 : n%10==0 && n!=0 ? 2 : 3' },
  lt_LT: { nplurals: 3, expression: 'n%10==1 && n%100!=11 ? 0 : n%10>=2 && (n%100<10 || n%100>=20) ? 1 : 2' },
  pl_PL: { nplurals: 3, expression: 'n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2' },
  ro_RO: { nplurals: 3, expression: 'n==1 ? 0 : n==0 || (n%100>0 && n%100<20) ? 1 : 2' },
  ru_RU: { nplurals: 3, expression: 'n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2' },
  uk: { nplurals: 3, expression: 'n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2' },
};
const SINGLE_FORM_LOCALES = new Set([
  'id_ID', 'ja', 'km', 'ko_KR', 'ms_MY', 'th', 'vi', 'zh', 'zh_CN', 'zh_TW',
]);
const FRENCH_STYLE_LOCALES = new Set(['fr', 'fr_CA', 'fr_FR', 'pt_BR']);

function getPhpPluralForms(locale) {
  const explicit = PHP_PLURAL_FORMS[locale];
  const base = explicit
    ?? (SINGLE_FORM_LOCALES.has(locale)
      ? { nplurals: 1, expression: '0' }
      : FRENCH_STYLE_LOCALES.has(locale)
        ? { nplurals: 2, expression: 'n > 1' }
        : { nplurals: 2, expression: 'n != 1' });
  return { ...base, header: `nplurals=${base.nplurals}; plural=${base.expression};` };
}

function upsertPoHeaderLine(header, key, value) {
  const lines = header.split('\n').filter((line) => line.trim() !== '');
  const prefix = `${key}:`;
  const index = lines.findIndex((line) => line.toLowerCase().startsWith(prefix.toLowerCase()));
  if (index >= 0) {
    lines[index] = `${key}: ${value}`;
  } else {
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

function ensurePoHeader(header, domain, locale) {
  let next = header.trim() || [
    `Project-Id-Version: ${domain}`,
    'Report-Msgid-Bugs-To: https://github.com/wcpos/woocommerce-pos/issues',
    'Last-Translator: WCPOS Translation Pipeline <noreply@wcpos.com>',
    'Language-Team: WCPOS',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'X-Generator: WCPOS Translation Pipeline',
    `X-Domain: ${domain}`,
  ].join('\n');
  next = upsertPoHeaderLine(next, 'Language', locale);
  next = upsertPoHeaderLine(next, 'Plural-Forms', getPhpPluralForms(locale).header);
  return next;
}

function parsePoHeaders(header) {
  const headers = {};
  for (const line of header.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    headers[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return headers;
}

function phpString(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
}

function unescapePo(s) {
  return s.replace(/\\(.)/g, (_match, c) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case '"': return '"';
      case '\\': return '\\';
      default: return `\\${c}`;
    }
  });
}

function escapePo(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

function extractQuotedString(line) {
  const match = line.match(/"((?:[^"\\]|\\.)*)"/);
  return match ? unescapePo(match[1]) : '';
}

function readMultiLineString(lines, start) {
  let i = start;
  const parts = [];
  const firstMatch = lines[i].match(/"((?:[^"\\]|\\.)*)"/);
  if (firstMatch) {
    parts.push(unescapePo(firstMatch[1]));
  }
  i++;
  while (i < lines.length && lines[i].startsWith('"')) {
    parts.push(extractQuotedString(lines[i]));
    i++;
  }
  return { value: parts.join(''), nextLine: i };
}

function parsePoFile(content) {
  const lines = content.split('\n');
  const entries = [];
  let header = '';
  let i = 0;
  while (i < lines.length && lines[i].startsWith('#')) i++;
  if (i < lines.length && lines[i] === 'msgid ""') {
    i++;
    if (i < lines.length && lines[i].startsWith('msgstr "')) {
      const headerLines = [];
      headerLines.push(extractQuotedString(lines[i]));
      i++;
      while (i < lines.length && lines[i].startsWith('"')) {
        headerLines.push(extractQuotedString(lines[i]));
        i++;
      }
      header = headerLines.join('');
    }
  }
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    const comments = [];
    const flags = [];
    while (i < lines.length && lines[i].startsWith('#')) {
      if (lines[i].startsWith('#,')) {
        flags.push(...lines[i].slice(2).trim().split(',').map((f) => f.trim()));
      }
      comments.push(lines[i]);
      i++;
    }
    if (i >= lines.length) break;
    let msgctxt;
    if (lines[i].startsWith('msgctxt ')) {
      const context = readMultiLineString(lines, i);
      msgctxt = context.value;
      i = context.nextLine;
    }
    if (i >= lines.length || !lines[i].startsWith('msgid ')) { i++; continue; }
    const msgid = readMultiLineString(lines, i);
    i = msgid.nextLine;
    let msgid_plural;
    if (i < lines.length && lines[i].startsWith('msgid_plural ')) {
      const plural = readMultiLineString(lines, i);
      msgid_plural = plural.value;
      i = plural.nextLine;
    }
    let msgstr = '';
    const msgstr_plural = [];
    if (i < lines.length && lines[i].startsWith('msgstr[')) {
      while (i < lines.length && lines[i].startsWith('msgstr[')) {
        const ms = readMultiLineString(lines, i);
        msgstr_plural.push(ms.value);
        i = ms.nextLine;
      }
      msgstr = msgstr_plural[0] ?? '';
    } else if (i < lines.length && lines[i].startsWith('msgstr ')) {
      const ms = readMultiLineString(lines, i);
      msgstr = ms.value;
      i = ms.nextLine;
    }
    if (msgid.value === '') continue;
    entries.push({
      comments,
      msgctxt,
      msgid: msgid.value,
      msgid_plural,
      msgstr,
      msgstr_plural: msgstr_plural.length > 0 ? msgstr_plural : undefined,
      flags,
    });
  }
  return { header, entries };
}

function formatPoString(keyword, value) {
  const escaped = escapePo(value);
  if (escaped.length < 70 && !escaped.includes('\\n')) {
    return [`${keyword} "${escaped}"`];
  }
  const lines = [`${keyword} ""`];
  const segments = escaped.split('\\n');
  for (let j = 0; j < segments.length; j++) {
    const suffix = j < segments.length - 1 ? '\\n' : '';
    const segment = segments[j] + suffix;
    if (segment === '') continue;
    lines.push(`"${segment}"`);
  }
  return lines;
}

function serializePoEntry(entry) {
  const lines = [];
  for (const c of entry.comments) lines.push(c);
  if (entry.msgctxt !== undefined) {
    lines.push(...formatPoString('msgctxt', entry.msgctxt));
  }
  lines.push(...formatPoString('msgid', entry.msgid));
  if (entry.msgid_plural !== undefined) {
    lines.push(...formatPoString('msgid_plural', entry.msgid_plural));
  }
  if (entry.msgstr_plural && entry.msgstr_plural.length > 0) {
    for (let j = 0; j < entry.msgstr_plural.length; j++) {
      lines.push(...formatPoString(`msgstr[${j}]`, entry.msgstr_plural[j]));
    }
  } else {
    lines.push(...formatPoString('msgstr', entry.msgstr));
  }
  return lines.join('\n');
}

function serializePoFile(header, entries) {
  const headerLines = [
    '# This file is distributed under the GPL-3.0+.',
    'msgid ""',
    'msgstr ""',
  ];
  for (const line of header.split('\n')) {
    if (line) headerLines.push(`"${escapePo(line)}\\n"`);
  }
  const parts = [headerLines.join('\n'), ''];
  for (const entry of entries) {
    parts.push(serializePoEntry(entry));
    parts.push('');
  }
  return parts.join('\n');
}

function buildPoEntryKey(msgctxt, msgid) {
  return `${msgctxt ?? ''}\u0004${msgid}`;
}

function hasPoEntryTranslation(entry, expectedPluralForms) {
  if (entry.msgid_plural !== undefined && expectedPluralForms !== undefined) {
    return (
      entry.msgstr_plural !== undefined
      && entry.msgstr_plural.length === expectedPluralForms
      && entry.msgstr_plural.every((form) => form.trim() !== '')
    );
  }
  const forms = entry.msgstr_plural && entry.msgstr_plural.length > 0
    ? entry.msgstr_plural
    : [entry.msgstr];
  return forms.length > 0 && forms.every((form) => form.trim() !== '');
}

function mergePoEntries(potEntries, existingEntries, expectedPluralForms) {
  const mergedEntries = [];
  const untranslated = [];
  const existingByKey = new Map();
  for (const entry of existingEntries) {
    existingByKey.set(buildPoEntryKey(entry.msgctxt, entry.msgid), entry);
  }
  let skipped = 0;
  for (const potEntry of potEntries) {
    const existing = existingByKey.get(buildPoEntryKey(potEntry.msgctxt, potEntry.msgid));
    const samePluralShape =
      existing
      && existing.msgid_plural === potEntry.msgid_plural
      && Boolean(existing.msgstr_plural?.length) === Boolean(potEntry.msgid_plural);
    if (samePluralShape && hasPoEntryTranslation(existing, expectedPluralForms)) {
      mergedEntries.push({
        ...potEntry,
        msgstr: existing.msgstr,
        msgstr_plural: existing.msgstr_plural ? [...existing.msgstr_plural] : undefined,
      });
      skipped++;
      continue;
    }
    mergedEntries.push({ ...potEntry });
    untranslated.push({ index: mergedEntries.length - 1, entry: potEntry });
  }
  return { mergedEntries, untranslated, skipped };
}

function generateL10nPhp(entries, header = '') {
  const headers = parsePoHeaders(header);
  const lines = ['<?php', 'return array('];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`\t'${phpString(key)}' => '${phpString(value)}',`);
  }
  lines.push('\t\'messages\' => array(');
  for (const entry of entries) {
    const forms = entry.msgstr_plural && entry.msgstr_plural.length > 0
      ? entry.msgstr_plural
      : [entry.msgstr];
    if (forms.every((form) => !form || form.trim() === '')) continue;
    const rawKey = entry.msgctxt ? `${entry.msgctxt}\x04${entry.msgid}` : entry.msgid;
    const rawValue = forms.length > 1 ? forms.join('\x00') : forms[0];
    const escapedKey = phpString(rawKey);
    const escapedValue = phpString(rawValue);
    const phpKey = escapedKey.replace(/\x04/g, `' . "\\x04" . '`);
    const phpValue = escapedValue.replace(/\x00/g, `' . "\\x00" . '`);
    lines.push(`\t\t'${phpKey}' => '${phpValue}',`);
  }
  lines.push('\t),');
  lines.push(');');
  lines.push('');
  return lines.join('\n');
}

function parsePluralSlotCount(header) {
  const match = header.match(/Plural-Forms:\s*[^\n]*nplurals\s*=\s*(\d+)/iu);
  if (!match?.[1]) return undefined;
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

module.exports = {
  getPhpPluralForms, ensurePoHeader, parsePoFile, serializePoFile, buildPoEntryKey,
  hasPoEntryTranslation, mergePoEntries, generateL10nPhp, parsePluralSlotCount,
};
