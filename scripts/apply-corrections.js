#!/usr/bin/env node

/**
 * Apply reviewed "ships -> should be" corrections to shipped translations.
 *
 * Usage:
 *   node scripts/apply-corrections.js <corrections.json> [--dry-run] [--locale <loc> ...] [--root <dir>]
 *
 * Each correction names a locale, a target and the values it may replace:
 *   { "locale": "pt_BR", "key": "pos_checkout.change_reader", "from": ["Troco"], "to": "Trocar" }
 *   - "key": a JS key (every translations/js/<locale>/** file holding it), or "po:<msgid>"
 *     (every entry with that msgid, any msgctxt, in translations/php/<locale>/*.po).
 *   - "source": an English source string (or a list of them); matches every JS key whose
 *     English (source/js/**) and every PO msgid equal it after trimming.
 * A value is replaced only when it equals one of "from" (the guard), and only when "to"
 * keeps the same {placeholders}. Plural PO entries (msgstr[n]) are not supported and are
 * reported UNMATCHED; JS plural keys are addressed by their full suffixed key.
 * PO writes also regenerate the sibling .l10n.php and .mo with scripts/po-file.js.
 */

const fs = require('fs');
const path = require('path');
const { parsePoFile, serializePoFile, generateL10nPhp, compileMo } = require('./po-file');
const { sourceTextForTranslationKey } = require('./check-completeness');

// The ten locales of the 2026-11-22 review; SIBLINGS counts how many of the others
// ship the same old value for the same key (information only).
const SIBLING_LOCALES = ['de_DE', 'es_ES', 'fr_FR', 'it_IT', 'pt_BR', 'nl_NL', 'ru_RU', 'pl_PL', 'ja', 'zh_CN'];

const placeholders = (s) => (String(s).match(/\{[^{}]+\}/g) || []).sort().join('|');

function listJson(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJson(full, base, out);
    else if (entry.name.endsWith('.json')) out.push(path.relative(base, full));
  }
  return out;
}

function loadLocale(root, locale) {
  const files = [];
  const jsDir = path.join(root, 'translations/js', locale);
  for (const rel of listJson(jsDir)) {
    const full = path.join(jsDir, rel);
    const text = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(text);
    const indent = (text.match(/^[ \t]+(?=")/m) || ['  '])[0];
    const newline = text.endsWith('\n') ? '\n' : '';
    const render = (value) => JSON.stringify(value, null, indent) + newline;
    if (render(data) !== text) throw new Error(`${full}: does not round-trip through JSON; refusing to edit`);
    const sourcePath = path.join(root, 'source/js', rel);
    const source = fs.existsSync(sourcePath) ? JSON.parse(fs.readFileSync(sourcePath, 'utf8')) : {};
    files.push({ kind: 'js', rel: `js/${locale}/${rel}`, full, data, render, source, dirty: false });
  }
  const phpDir = path.join(root, 'translations/php', locale);
  const poNames = fs.existsSync(phpDir) ? fs.readdirSync(phpDir).filter((n) => n.endsWith('.po')).sort() : [];
  for (const name of poNames) {
    const full = path.join(phpDir, name);
    const text = fs.readFileSync(full, 'utf8');
    const po = parsePoFile(text);
    if (serializePoFile(po.header, po.entries) !== text) throw new Error(`${full}: does not round-trip; refusing to edit`);
    files.push({ kind: 'po', rel: `php/${locale}/${name}`, full, po, dirty: false });
  }
  return files;
}

// Every entry a correction targets: { file, id, get(), set(v), plural }.
function targets(files, correction) {
  const sources = correction.source === undefined ? null : [].concat(correction.source).map((s) => s.trim());
  const poId = correction.key && correction.key.startsWith('po:') ? correction.key.slice(3) : null;
  const found = [];
  for (const file of files) {
    if (file.kind === 'js' && !poId) {
      for (const key of Object.keys(file.data)) {
        const english = sourceTextForTranslationKey(file.source, key);
        const hit = sources ? typeof english === 'string' && sources.includes(english.trim()) : key === correction.key;
        if (hit) found.push({ file, id: key, get: () => file.data[key], set: (v) => { file.data[key] = v; } });
      }
    } else if (file.kind === 'po' && (poId !== null || sources)) {
      for (const entry of file.po.entries) {
        const hit = sources ? sources.includes(entry.msgid.trim()) : entry.msgid === poId;
        if (!hit) continue;
        const id = `${entry.msgctxt !== undefined ? `[${entry.msgctxt}] ` : ''}${JSON.stringify(entry.msgid)}`;
        found.push({ file, id, plural: Boolean(entry.msgstr_plural), get: () => entry.msgstr, set: (v) => { entry.msgstr = v; } });
      }
    }
  }
  return found;
}

function siblingCount(root, cache, locale, target, old) {
  let count = 0;
  for (const other of SIBLING_LOCALES) {
    if (other === locale) continue;
    if (!cache.has(other)) cache.set(other, loadLocale(root, other));
    const rel = target.file.rel.replace(`/${locale}/`, `/${other}/`).replace(`-${locale}.po`, `-${other}.po`);
    const file = cache.get(other).find((f) => f.rel === rel);
    if (!file) continue;
    const value = file.kind === 'js' ? file.data[target.id]
      : file.po.entries.find((e) => `${e.msgctxt !== undefined ? `[${e.msgctxt}] ` : ''}${JSON.stringify(e.msgid)}` === target.id)?.msgstr;
    if (value === old) count++;
  }
  return count;
}

function applyCorrections({ root = path.resolve(__dirname, '..'), corrections, locales = null, dryRun = false }) {
  const byLocale = new Map();
  corrections.forEach((c, index) => {
    const valid = typeof c.locale === 'string' && typeof c.to === 'string' && Array.isArray(c.from)
      && (typeof c.key === 'string') !== (c.source !== undefined);
    if (!valid) throw new Error(`correction #${index}: needs locale, from[], to and exactly one of key/source`);
    if (locales && !locales.includes(c.locale)) return;
    if (!byLocale.has(c.locale)) byLocale.set(c.locale, []);
    byLocale.get(c.locale).push({ ...c, index });
  });
  const siblingCache = new Map();
  const report = [];
  const totals = { change: 0, unmatched: 0, already: 0 };
  for (const [locale, list] of [...byLocale].sort((a, b) => a[0].localeCompare(b[0]))) {
    const files = loadLocale(root, locale);
    const changes = [];
    const unmatched = [];
    const siblings = [];
    let already = 0;
    for (const c of list) {
      const label = `#${c.index} ${c.key ? `key ${c.key}` : `source ${JSON.stringify(c.source)}`}`;
      const found = targets(files, c);
      if (found.length === 0) unmatched.push(`${label}: no entry`);
      for (const t of found) {
        const current = t.get();
        const where = `${t.file.rel} ${t.id}`;
        if (current === c.to) { already++; continue; }
        if (t.plural) { unmatched.push(`${label}: ${where} is a plural PO entry (not supported)`); continue; }
        if (!c.from.includes(current)) { unmatched.push(`${label}: ${where} current ${JSON.stringify(current)}`); continue; }
        if (placeholders(current) !== placeholders(c.to)) { unmatched.push(`${label}: ${where} placeholder mismatch`); continue; }
        const count = siblingCount(root, siblingCache, locale, t, current);
        t.set(c.to);
        t.file.dirty = true;
        changes.push(`CHANGE ${where}: ${JSON.stringify(current)} → ${JSON.stringify(c.to)}`);
        siblings.push(`${where}: ${count} of ${SIBLING_LOCALES.filter((l) => l !== locale).length} other locales ship ${JSON.stringify(current)}`);
      }
    }
    if (!dryRun) {
      for (const file of files.filter((f) => f.dirty)) {
        if (file.kind === 'js') { fs.writeFileSync(file.full, file.render(file.data)); continue; }
        const text = serializePoFile(file.po.header, file.po.entries);
        fs.writeFileSync(file.full, text);
        const written = parsePoFile(text);
        fs.writeFileSync(file.full.replace(/\.po$/, '.l10n.php'), generateL10nPhp(written.entries, written.header));
        fs.writeFileSync(file.full.replace(/\.po$/, '.mo'), compileMo(written.entries, written.header));
      }
    }
    totals.change += changes.length;
    totals.unmatched += unmatched.length;
    totals.already += already;
    report.push(`## ${locale}`, '', `${changes.length} changes, ${unmatched.length} unmatched, ${already} already applied`, '');
    const section = (title, rows) => report.push(`### ${title}`, '', ...(rows.length ? rows.map((r) => `- ${r}`) : ['- none']), '');
    section('CHANGE', changes);
    section('UNMATCHED', unmatched);
    section('SIBLINGS', siblings);
  }
  const head = [`# Corrections ${dryRun ? '(dry run)' : '(applied)'}`, '',
    `Total: ${totals.change} changes, ${totals.unmatched} unmatched, ${totals.already} already applied`, ''];
  return { totals, markdown: head.concat(report).join('\n') };
}

function main(argv) {
  let file = null;
  let root;
  let dryRun = false;
  let locales = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--locale') {
      locales = locales || [];
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) locales.push(argv[++i]);
    } else if (!file) file = argv[i];
    else { console.error(`Unknown argument: ${argv[i]}`); return 2; }
  }
  if (!file) { console.error('Usage: apply-corrections.js <corrections.json> [--dry-run] [--locale <loc> ...]'); return 2; }
  const { corrections } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { markdown } = applyCorrections({ root, corrections, locales, dryRun });
  process.stdout.write(`${markdown}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { applyCorrections };
