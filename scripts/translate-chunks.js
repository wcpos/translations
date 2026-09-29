#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parsePluralKey } = require('./plural-rules');

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
    // A unit is one PHP entry, one JS key, or all plural siblings of a JS key (kept in one part).
    const units = new Map();
    for (const item of items) {
      const plural = item[0] === 'js' && item[3].plural_category ? parsePluralKey(item[2]) : null;
      const id = plural ? `js\0${item[1]}\0${plural.base}` : `${item[0]}\0${item[1]}\0${item[2]}`;
      if (!units.has(id)) units.set(id, []);
      units.get(id).push(item);
    }
    const count = Math.ceil(n / max), goal = Math.ceil(n / count), slices = [[]];
    for (const unit of units.values()) {
      const current = slices[slices.length - 1];
      if (current.length && (current.length >= goal || current.length + unit.length > max)) slices.push([]);
      slices[slices.length - 1].push(...unit);
    }
    fs.mkdirSync(partsDir, { recursive: true });
    for (const [i, slice] of slices.entries()) {
      const part = { ...packet, counts: { js: 0, php: 0 }, js: {}, php: {} };
      for (const [kind, group, key, entry] of slice) {
        if (kind === 'js') (part.js[group] ??= {})[key] = entry;
        else (part.php[group] ??= { ...packet.php[group], entries: [] }).entries.push(entry);
        part.counts[kind]++;
      }
      const target = path.join(partsDir, `${packet.locale}.part${i + 1}.json`);
      fs.writeFileSync(target, JSON.stringify(part, null, 2) + '\n');
      packets.push([target, slice.length]);
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

module.exports = { planChunks };
if (require.main === module) {
  const [command, first, second, max] = process.argv.slice(2);
  if (command === 'plan' && process.argv.length === 6 && Number.isInteger(Number(max)) && Number(max) > 0) {
    for (const chunk of planChunks({ workDir: first, partsDir: second, max: Number(max) })) console.log(chunk.join(' '));
  } else { console.error('Usage: translate-chunks.js plan <workDir> <partsDir> <max>'); process.exitCode = 2; }
}
