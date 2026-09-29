#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function planChunks({ workDir, partsDir, max }) {
  const chunks = [], packets = [];
  for (const file of fs.readdirSync(workDir).filter(file => file.endsWith('.json')).sort()) {
    const packet = JSON.parse(fs.readFileSync(path.join(workDir, file), 'utf8'));
    const n = packet.counts.js + packet.counts.php;
    if (n <= max) {
      packets.push([path.join(workDir, file), n]);
      continue;
    }
    const items = [
      ...Object.entries(packet.js).flatMap(([file, entries]) => Object.entries(entries)
        .map(([key, entry]) => ['js', file, key, entry])),
      ...Object.entries(packet.php).flatMap(([domain, data]) => data.entries
        .map(entry => ['php', domain, entry.id, entry])),
    ];
    const count = Math.ceil(n / max);
    fs.mkdirSync(partsDir, { recursive: true });
    for (let i = 0, offset = 0; i < count; i++) {
      const size = Math.floor(n / count) + (i < n % count ? 1 : 0);
      const part = { ...packet, counts: { js: 0, php: 0 }, js: {}, php: {} };
      for (const [kind, group, key, entry] of items.slice(offset, offset + size)) {
        if (kind === 'js') (part.js[group] ??= {})[key] = entry;
        else (part.php[group] ??= { ...packet.php[group], entries: [] }).entries.push(entry);
        part.counts[kind]++;
      }
      const target = path.join(partsDir, `${packet.locale}.part${i + 1}.json`);
      fs.writeFileSync(target, JSON.stringify(part, null, 2) + '\n');
      packets.push([target, size]);
      offset += size;
    }
  }
  let chunk = [], sum = 0;
  for (const [file, n] of packets) {
    if (chunk.length && sum + n > max) { chunks.push(chunk); chunk = []; sum = 0; }
    chunk.push(file); sum += n;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function mergePartResults({ partsDir, resultsDir }) {
  if (!fs.existsSync(partsDir)) return;
  const merged = {};
  for (const file of fs.readdirSync(partsDir).sort()) {
    const match = file.match(/^(.*)\.part\d+\.json$/);
    if (!match) continue;
    const [, locale] = match;
    let result;
    try { result = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8')); } catch { continue; }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.locale !== locale) continue;
    const target = merged[locale] ??= { locale, js: {}, php: {} };
    for (const [file, entries] of Object.entries(result.js || {})) Object.assign(target.js[file] ??= {}, entries);
    Object.assign(target.php, result.php);
  }
  for (const result of Object.values(merged)) fs.writeFileSync(path.join(resultsDir, `${result.locale}.json`), JSON.stringify(result, null, 2) + '\n');
}

module.exports = { planChunks, mergePartResults };
if (require.main === module) {
  const [command, first, second, max] = process.argv.slice(2);
  if (command === 'plan' && process.argv.length === 6 && Number.isInteger(Number(max)) && Number(max) > 0) {
    for (const chunk of planChunks({ workDir: first, partsDir: second, max: Number(max) })) console.log(chunk.join(' '));
  } else if (command === 'merge' && process.argv.length === 5) mergePartResults({ partsDir: first, resultsDir: second });
  else { console.error('Usage: translate-chunks.js plan <workDir> <partsDir> <max> | merge <partsDir> <resultsDir>'); process.exitCode = 2; }
}
