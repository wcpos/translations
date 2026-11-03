#!/usr/bin/env node
// Recover results objects the translator printed in its last message but did not write.
// Usage: node scripts/recover-results.js <message-file> <results-dir> <packet-path>...
const fs = require('node:fs');
const path = require('node:path');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allOf = (object, test) => isObject(object) && Object.values(object).every(test);
const isString = value => typeof value === 'string';

// Results hold string leaves; work packets hold {source, ...} objects and {entries} domains, so they fail here.
function isResults(value) {
  if (!isObject(value) || !isString(value.locale)) return false;
  const hasJs = Object.hasOwn(value, 'js'), hasPhp = Object.hasOwn(value, 'php');
  if (hasJs && !allOf(value.js, file => allOf(file, isString))) return false;
  if (hasPhp && !allOf(value.php, forms => Array.isArray(forms) && forms.every(isString))) return false;
  return hasJs || hasPhp;
}

// Every results object in the text, in order: from each `{`, find its closing `}` (skipping JSON strings) and parse.
function candidates(text) {
  const found = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false, end = -1;
    for (let i = start; i < text.length && end === -1; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) end = i;
    }
    if (end === -1) continue;
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (isResults(value)) found.push(value);
    } catch {} // Not JSON; keep scanning.
  }
  return found;
}

function packetLocale(packet) {
  try {
    return JSON.parse(fs.readFileSync(packet, 'utf8')).locale;
  } catch (error) {
    console.error(`cannot read packet ${packet}: ${error.message}`);
  }
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('usage: node scripts/recover-results.js <message-file> <results-dir> <packet-path>...');
  process.exit(2);
}
const [messageFile, resultsDir, ...packets] = args;
try {
  const message = fs.existsSync(messageFile) ? fs.readFileSync(messageFile, 'utf8') : '';
  const missing = message ? packets.map(packet => {
    const name = path.basename(packet, '.json'), target = path.join(resultsDir, name + '.json');
    return fs.existsSync(target) ? null : { name, target, locale: packetLocale(packet) };
  }).filter(Boolean) : [];
  const found = missing.length ? candidates(message) : [];
  for (const { name, target, locale } of missing) {
    // A results object names only its locale, so it cannot say which part of that locale it belongs to.
    if (locale === undefined || missing.filter(other => other.locale === locale).length > 1) continue;
    const match = found.filter(candidate => candidate.locale === locale).pop();
    if (!match) continue;
    fs.writeFileSync(target, JSON.stringify(match) + '\n');
    console.log(`recovered ${name} from the translator's last message`);
  }
} catch (error) {
  console.error(`result recovery: ${error.message}`); // Never fail the run; translate-local.sh logs what is missing.
}
