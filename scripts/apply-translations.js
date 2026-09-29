#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { checkTranslation, normalizeWcposProductNames, checkEnglishSource } = require('./translation-rules');
const {
  parsePoFile, serializePoFile, ensurePoHeader, parsePluralSlotCount, getPhpPluralForms,
  mergePoEntries, buildPoEntryKey, generateL10nPhp,
} = require('./po-file');

function applyTranslations({ rootDir = path.resolve(__dirname, '..'), workDir, resultsDir, partsDir }) {
  const report = {
    applied: 0, rejected: [], warnings: [], source_warnings: [],
    missing_results: [], unexpected: 0, files_written: [],
  };
  const seenSources = new Set();
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Parse a results file; null when it is not a valid results object for this locale.
  const readResults = (file, locale) => {
    let results;
    try {
      results = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (isObject(results)) {
      if (!Object.hasOwn(results, 'js')) results.js = {};
      if (!Object.hasOwn(results, 'php')) results.php = {};
    }
    return !isObject(results) || results.locale !== locale || !isObject(results.js)
      || !isObject(results.php) || !Object.values(results.js).every(isObject) ? null : results;
  };
  for (const packetFile of fs.readdirSync(workDir).filter(file => file.endsWith('.json')).sort()) {
    const packet = JSON.parse(fs.readFileSync(path.join(workDir, packetFile), 'utf8'));
    const { locale } = packet;
    const items = [
      ...Object.entries(packet.js).flatMap(([file, entries]) => Object.entries(entries)
        .map(([key, entry]) => ({ file, key, sources: [entry.source], forms: 1, js: true }))),
      ...Object.entries(packet.php).flatMap(([file, domain]) => domain.entries.map(entry => ({
        file, key: `${entry.msgctxt !== undefined ? `[${entry.msgctxt}] ` : ''}${entry.msgid}`,
        sources: entry.msgid_plural === undefined ? [entry.msgid] : [entry.msgid, entry.msgid_plural],
        forms: entry.forms, entry,
      }))),
    ];
    for (const { file, key, sources } of items) {
      for (const source of sources) {
        if (seenSources.has(source)) continue;
        seenSources.add(source);
        const warnings = checkEnglishSource(source, 'american');
        if (warnings.length) report.source_warnings.push({ file, key, warnings });
      }
    }
    const partNames = partsDir && fs.existsSync(partsDir) ? fs.readdirSync(partsDir)
      .filter(file => file.startsWith(`${locale}.part`) && file.endsWith('.json')
        && /^\d+$/.test(file.slice(locale.length + 5, -5)))
      .map(file => file.slice(0, -5)).sort((a, b) => Number(a.slice(locale.length + 5)) - Number(b.slice(locale.length + 5))) : [];
    let results;
    if (partNames.length) {
      // Split locale: build the results from the part results, each part limited to its own keys and ids.
      results = { locale, js: {}, php: {} };
      let found = false;
      for (const name of partNames) {
        const partPath = path.join(resultsDir, `${name}.json`);
        if (!fs.existsSync(partPath)) continue;
        found = true;
        const part = JSON.parse(fs.readFileSync(path.join(partsDir, `${name}.json`), 'utf8'));
        const inPart = ({ js, file, key, entry }) => (js
          ? Object.hasOwn(part.js, file) && Object.hasOwn(part.js[file], key)
          : Object.hasOwn(part.php, file) && part.php[file].entries.some(({ id }) => id === entry.id));
        const partResults = readResults(partPath, locale);
        if (!partResults) {
          for (const item of items.filter(inPart)) {
            item.skip = true;
            report.rejected.push({ locale, file: item.file, key: item.key, reasons: [`invalid results file (${name})`] });
          }
          continue;
        }
        const put = (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
        for (const [file, entries] of Object.entries(partResults.js)) {
          for (const [key, value] of Object.entries(entries)) {
            if (inPart({ js: true, file, key })) put(results.js[file] ??= {}, key, value);
            else report.unexpected++;
          }
        }
        for (const [id, value] of Object.entries(partResults.php)) {
          if (items.some(item => !item.js && item.entry.id === id && inPart(item))) put(results.php, id, value);
          else report.unexpected++;
        }
      }
      if (!found) {
        report.missing_results.push(locale);
        continue;
      }
    } else {
      const resultsPath = path.join(resultsDir, `${locale}.json`);
      if (!fs.existsSync(resultsPath)) {
        report.missing_results.push(locale);
        continue;
      }
      results = readResults(resultsPath, locale);
      if (!results) {
        for (const { file, key } of items) {
          report.rejected.push({ locale, file, key, reasons: ['invalid results file'] });
        }
        continue;
      }
    }
    for (const [file, entries] of Object.entries(results.js)) {
      for (const key of Object.keys(entries)) {
        if (!Object.hasOwn(packet.js, file) || !Object.hasOwn(packet.js[file], key)) report.unexpected++;
      }
    }
    const ids = new Set(items.filter(item => !item.js).map(item => item.entry.id));
    for (const id of Object.keys(results.php)) if (!ids.has(id)) report.unexpected++;
    for (const item of items) {
      if (item.skip) continue;
      const { file, key, sources, forms, js, entry } = item;
      const values = js ? results.js[file] : results.php;
      const resultKey = js ? key : entry.id;
      const reasons = [];
      const warnings = [];
      let translations;
      if (!values || !Object.hasOwn(values, resultKey)) {
        reasons.push('no translation returned');
      } else {
        translations = js ? [values[resultKey]] : values[resultKey];
        if (!Array.isArray(translations) || translations.length !== forms) {
          reasons.push(`Expected ${forms} translation forms`);
        } else if (!translations.every(value => typeof value === 'string')) {
          reasons.push('Translation values must be strings');
        } else {
          translations = translations.map(normalizeWcposProductNames);
          translations.forEach((translation, index) => {
            const checked = checkTranslation({ locale, source: sources[index === 0 ? 0 : 1], translation });
            reasons.push(...checked.errors);
            warnings.push(...checked.warnings);
          });
        }
      }
      if (warnings.length) report.warnings.push({ locale, file, key, warnings: [...new Set(warnings)] });
      if (reasons.length) report.rejected.push({ locale, file, key, reasons: [...new Set(reasons)] });
      else item.translations = translations;
    }
    for (const file of Object.keys(packet.js)) {
      const accepted = items.filter(item => item.js && item.file === file && item.translations);
      if (!accepted.length) continue;
      const relative = `translations/js/${locale}/${file}`;
      const target = path.join(rootDir, relative);
      const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
      let changed = false;
      for (const { key, translations } of accepted) {
        if (Object.hasOwn(existing, key)) continue;
        Object.defineProperty(existing, key, { value: translations[0], enumerable: true });
        report.applied++;
        changed = true;
      }
      if (!changed) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(existing, null, 2) + '\n');
      report.files_written.push(relative);
    }
    for (const domain of Object.keys(packet.php)) {
      const accepted = new Map(items.filter(item => !item.js && item.file === domain && item.translations)
        .map(item => [buildPoEntryKey(item.entry.msgctxt, item.entry.msgid), item.translations]));
      if (!accepted.size) continue;
      const relative = `translations/php/${locale}/${domain}-${locale}.po`;
      const target = path.join(rootDir, relative);
      const existing = fs.existsSync(target)
        ? parsePoFile(fs.readFileSync(target, 'utf8')) : { header: '', entries: [] };
      const pot = parsePoFile(fs.readFileSync(path.join(rootDir, 'source/php', `${domain}.pot`), 'utf8'));
      const header = ensurePoHeader(existing.header, domain, locale);
      const slots = parsePluralSlotCount(header) ?? getPhpPluralForms(locale).nplurals;
      const { mergedEntries, untranslated } = mergePoEntries(pot.entries, existing.entries, slots);
      const originals = new Map(existing.entries.map(entry => [buildPoEntryKey(entry.msgctxt, entry.msgid), entry]));
      let changed = false;
      for (const { index, entry } of untranslated) {
        const key = buildPoEntryKey(entry.msgctxt, entry.msgid);
        const forms = accepted.get(key);
        if (forms) {
          mergedEntries[index].msgstr = forms[0];
          if (entry.msgid_plural !== undefined) mergedEntries[index].msgstr_plural = forms;
          report.applied++;
          changed = true;
        } else if (originals.has(key)) {
          mergedEntries[index].msgstr = originals.get(key).msgstr;
          mergedEntries[index].msgstr_plural = originals.get(key).msgstr_plural;
        }
      }
      if (!changed) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, serializePoFile(header, mergedEntries));
      fs.writeFileSync(target.replace(/\.po$/, '.l10n.php'), generateL10nPhp(mergedEntries, header));
      report.files_written.push(relative, relative.replace(/\.po$/, '.l10n.php'));
    }
  }
  report.files_written.sort();
  return report;
}

function markdownReport(report) {
  const lines = [`Applied: ${report.applied}; Rejected: ${report.rejected.length}; Warnings: ${report.warnings.length}; Files: ${report.files_written.length}`, ''];
  const cell = value => String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  for (const [title, entries, field] of [
    ['Rejected', report.rejected, 'reasons'], ['Warnings', report.warnings, 'warnings'],
    ['Source string warnings', report.source_warnings, 'warnings'],
  ]) {
    if (!entries.length) continue;
    lines.push(`## ${title}`, '', '| Locale | File | Key | Reason |', '| --- | --- | --- | --- |');
    for (const entry of entries.slice(0, 50)) {
      lines.push(`| ${[entry.locale ?? '', entry.file, entry.key, entry[field].join('; ')].map(cell).join(' | ')} |`);
    }
    if (entries.length > 50) lines.push('', `…and ${entries.length - 50} more`);
    lines.push('');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const args = {};
  const options = { '--work': 'workDir', '--results': 'resultsDir', '--parts': 'partsDir', '--root': 'rootDir', '--report': 'report', '--report-md': 'reportMd' };
  try {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const option = argv[i];
      if (!Object.hasOwn(options, option)) throw new Error(`Unknown argument: ${option}`);
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
      args[options[option]] = path.resolve(value);
    }
    if (!args.workDir || !args.resultsDir) throw new Error('--work and --results are required');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
  if (!process.exitCode) {
    const report = applyTranslations(args);
    if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n');
    if (args.reportMd) fs.writeFileSync(args.reportMd, markdownReport(report));
    process.stdout.write(JSON.stringify({
      applied: report.applied, rejected: report.rejected.length,
      warnings: report.warnings.length, files: report.files_written.length,
    }) + '\n');
  }
}

module.exports = { applyTranslations };
