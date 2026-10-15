#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parsePoFile, serializePoFile, buildPoEntryKey, generateL10nPhp } = require('./po-file');

function mergeJson(nextText, mainText, baseText) {
  const next = JSON.parse(nextText);
  const main = JSON.parse(mainText);
  const base = baseText === undefined ? {} : JSON.parse(baseText);
  const values = { ...main, ...next };
  for (const key of Object.keys(values)) {
    if (Object.hasOwn(base, key) && (!Object.hasOwn(next, key) ||
      (!Object.hasOwn(main, key) && JSON.stringify(base[key]) === JSON.stringify(next[key])))) delete values[key];
  }
  const sorted = Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]]));
  return JSON.stringify(sorted, null, 2) + '\n';
}

function poTranslationContent(entry) {
  return JSON.stringify([entry.msgid_plural ?? null, entry.msgstr ?? '', entry.msgstr_plural ?? [], [...(entry.flags ?? [])].sort()]);
}

function mergePo(nextText, mainText, baseText) {
  const next = parsePoFile(nextText);
  const main = parsePoFile(mainText);
  const base = new Map((baseText === undefined ? [] : parsePoFile(baseText).entries).map(entry => [buildPoEntryKey(entry.msgctxt, entry.msgid), entry]));
  const mainKeys = new Set(main.entries.map(entry => buildPoEntryKey(entry.msgctxt, entry.msgid)));
  const keys = new Set(next.entries.map(entry => buildPoEntryKey(entry.msgctxt, entry.msgid)));
  const entries = next.entries.filter(entry => {
    const key = buildPoEntryKey(entry.msgctxt, entry.msgid);
    return mainKeys.has(key) || !base.has(key) || poTranslationContent(base.get(key)) !== poTranslationContent(entry);
  });
  entries.push(...main.entries.filter(entry => {
    const key = buildPoEntryKey(entry.msgctxt, entry.msgid);
    return !keys.has(key) && !base.has(key);
  }));
  return { po: serializePoFile(next.header, entries), l10n: generateL10nPhp(entries, next.header) };
}

function resolveLaneConflicts({ cwd = process.cwd() } = {}) {
  const run = (command, args) => execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (...args) => run('git', args);
  const conflicts = new Map();
  for (const record of git('ls-files', '-u', '-z').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const file = record.slice(tab + 1);
    const stage = Number(record.slice(0, tab).split(' ')[2]);
    if (!conflicts.has(file)) conflicts.set(file, new Set());
    conflicts.get(file).add(stage);
  }
  const disallowed = [...conflicts.keys()].filter(file => {
    if (file.startsWith('source/')) return false;
    if (/^translations\/js\/.*\.json$/.test(file)) return false;
    if (/^translations\/php\/.*\.po$/.test(file)) return false;
    if (/^translations\/php\/.*\.l10n\.php$/.test(file)) {
      return !fs.existsSync(path.join(cwd, file.replace(/\.l10n\.php$/, '.po')));
    }
    return true;
  });
  if (disallowed.length) throw new Error(`Disallowed merge conflicts: ${disallowed.join(', ')}`);

  for (const [file, stages] of conflicts) {
    const isPo = /^translations\/php\/.*\.po$/.test(file);
    const isL10n = /^translations\/php\/.*\.l10n\.php$/.test(file);
    const poFile = isL10n ? file.replace(/\.l10n\.php$/, '.po') : file;
    if (isL10n && conflicts.has(poFile)) continue;
    if (!isL10n && (file.startsWith('source/') || !stages.has(2) || !stages.has(3))) {
      if (stages.has(2)) {
        git('checkout', '--ours', '--', file);
        git('add', '--', file);
      } else {
        git('rm', '-q', '--', file);
      }
      if (isPo) {
        const sibling = file.replace(/\.po$/, '.l10n.php');
        let exists = true;
        try { git('cat-file', '-e', `HEAD:${sibling}`); } catch { exists = false; }
        if (exists) {
          git('checkout', 'HEAD', '--', sibling);
          git('add', '--', sibling);
        } else {
          git('rm', '-q', '--ignore-unmatch', '--', sibling);
        }
      }
      continue;
    }
    if (!isPo && !isL10n) {
      fs.writeFileSync(path.join(cwd, file), mergeJson(git('show', `:2:${file}`), git('show', `:3:${file}`), stages.has(1) ? git('show', ':1:' + file) : undefined));
      git('add', '--', file);
      continue;
    }
    let l10n;
    if (isPo) {
      const merged = mergePo(git('show', `:2:${file}`), git('show', `:3:${file}`), stages.has(1) ? git('show', ':1:' + file) : undefined);
      fs.writeFileSync(path.join(cwd, file), merged.po);
      l10n = merged.l10n;
    } else {
      const parsed = parsePoFile(fs.readFileSync(path.join(cwd, poFile), 'utf8'));
      l10n = generateL10nPhp(parsed.entries, parsed.header);
    }
    const sibling = poFile.replace(/\.po$/, '.l10n.php');
    fs.writeFileSync(path.join(cwd, sibling), l10n);
    run('php', ['-r', "$r = require $argv[1]; exit(is_array($r) && isset($r['messages']) && is_array($r['messages']) ? 0 : 1);", path.resolve(cwd, sibling)]);
    git('add', '--', ...(isPo ? [file, sibling] : [sibling]));
  }
  return { resolved: [...conflicts.keys()] };
}

module.exports = { mergeJson, mergePo, resolveLaneConflicts };

if (require.main === module) {
  try {
    const { resolved } = resolveLaneConflicts();
    console.log(`Resolved ${resolved.length} conflicted paths`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
