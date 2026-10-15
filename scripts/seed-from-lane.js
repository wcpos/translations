#!/usr/bin/env node
// Copies another lane's translation for a missing string when that lane's English source is identical,
// so a string reaching both lanes is translated once and the lanes' JSON/PO files do not conflict on it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parsePoFile, buildPoEntryKey } = require('./po-file');
const DEFAULT_ROOT = path.resolve(__dirname, '..');

function seedFromLane({ rootDir = DEFAULT_ROOT, workDir, ref, outDir }) {
  const { sourceTextForTranslationKey } = require('./check-completeness');
  const cache = new Map();
  const read = relativePath => {
    if (!cache.has(relativePath)) {
      const result = spawnSync('git', ['show', `${ref}:${relativePath}`], { cwd: rootDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      let value = null;
      if (result.status === 0) {
        try {
          value = relativePath.endsWith('.json') ? JSON.parse(result.stdout) : parsePoFile(result.stdout);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      cache.set(relativePath, value);
    }
    return cache.get(relativePath);
  };
  for (const dir of ['work', 'results']) {
    const target = path.join(outDir, dir);
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(target)) {
      if (file.endsWith('.json')) fs.unlinkSync(path.join(target, file));
    }
  }
  const locales = {};
  let seeded = 0;
  for (const file of fs.readdirSync(workDir).filter(file => file.endsWith('.json')).sort()) {
    const packet = JSON.parse(fs.readFileSync(path.join(workDir, file), 'utf8'));
    const { locale } = packet;
    const work = { ...packet, js: {}, php: {}, counts: { js: 0, php: 0 } };
    const results = { locale, js: {}, php: {} };
    for (const [file, entries] of Object.entries(packet.js)) {
      const translations = read(`translations/js/${locale}/${file}`);
      const sources = read(`source/js/${file}`);
      if (!translations || !sources) continue;
      const selected = Object.entries(entries).filter(([key, entry]) => Object.hasOwn(translations, key)
        && typeof translations[key] === 'string' && translations[key].trim() !== ''
        && sourceTextForTranslationKey(sources, key) === entry.source);
      if (!selected.length) continue;
      work.js[file] = Object.fromEntries(selected);
      results.js[file] = Object.fromEntries(selected.map(([key]) => [key, translations[key]]));
      work.counts.js += selected.length;
    }
    for (const [domain, data] of Object.entries(packet.php)) {
      const po = read(`translations/php/${locale}/${domain}-${locale}.po`);
      if (!po) continue;
      const candidates = new Map(po.entries.map(entry => [buildPoEntryKey(entry.msgctxt, entry.msgid), entry]));
      const entries = data.entries.filter(entry => {
        const candidate = candidates.get(buildPoEntryKey(entry.msgctxt, entry.msgid));
        if (!candidate || candidate.msgid_plural !== entry.msgid_plural || candidate.flags.includes('fuzzy')) return false;
        const forms = entry.msgid_plural === undefined
          ? (candidate.msgstr_plural === undefined ? [candidate.msgstr] : [])
          : candidate.msgstr_plural ?? [];
        if (forms.length !== entry.forms || !forms.every(form => form.trim() !== '')) return false;
        results.php[entry.id] = [...forms];
        return true;
      });
      if (entries.length) work.php[domain] = { ...data, entries };
      work.counts.php += entries.length;
    }
    const count = work.counts.js + work.counts.php;
    if (!count) continue;
    for (const [dir, value] of [['work', work], ['results', results]]) {
      fs.writeFileSync(path.join(outDir, dir, `${locale}.json`), JSON.stringify(value, null, 2) + '\n');
    }
    locales[locale] = work.counts;
    seeded += count;
  }
  return { seeded, locales };
}

if (require.main === module) {
  try {
    const args = {};
    const options = { '--root': 'rootDir', '--work': 'workDir', '--ref': 'ref', '--out': 'outDir' };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const option = argv[i];
      if (!Object.hasOwn(options, option)) throw new Error(`Unknown argument: ${option}`);
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
      args[options[option]] = value;
    }
    if (!args.workDir || !args.ref || !args.outDir) throw new Error('--work, --ref and --out are required');
    process.stdout.write(JSON.stringify(seedFromLane(args)) + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { seedFromLane };
