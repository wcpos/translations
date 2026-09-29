#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planChunks, mergePartResults } = require('../scripts/translate-chunks');
const { applyTranslations } = require('../scripts/apply-translations');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-chunks-'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const packet = (locale, n) => ({
  locale, locale_name: 'Locale ' + locale, locale_notes: 'notes.md', glossary: { sale: 'salg' }, extra: 'preserved',
  counts: { js: n, php: 0 }, php: {},
  js: { 'app/x.json': Object.fromEntries(Array.from({ length: n }, (_, i) =>
    ['k' + i, { source: 'Source ' + i, concepts: ['sale'], plural_category: 'one' }])) },
});
function setup(name, packets) {
  const workDir = path.join(root, name, 'work'), partsDir = path.join(root, name, 'parts');
  const resultsDir = path.join(root, name, 'results');
  for (const dir of [workDir, resultsDir]) fs.mkdirSync(dir, { recursive: true });
  for (const p of packets) write(path.join(workDir, p.locale + '.json'), p);
  return { workDir, partsDir, resultsDir, max: 250 };
}
const items = p => [
  ...Object.entries(p.js).flatMap(([file, entries]) => Object.entries(entries).map(([key, entry]) => [file, key, entry])),
  ...Object.entries(p.php).flatMap(([domain, data]) => data.entries.map(entry => [domain, entry.id, entry])),
];
const resultFor = p => ({
  locale: p.locale,
  js: Object.fromEntries(Object.entries(p.js).map(([file, entries]) =>
    [file, Object.fromEntries(Object.keys(entries).map(key => [key, 'Oversat ' + key]))])),
  php: Object.fromEntries(Object.values(p.php).flatMap(data => data.entries.map(entry => [entry.id, ['Oversat']]))),
});

try {
  const da = packet('da', 300), keys = Object.entries(da.js['app/x.json']);
  da.js = { 'app/x.json': Object.fromEntries(keys.slice(0, 150)), 'app/y.json': Object.fromEntries(keys.slice(150)) };
  da.php.shop = { nplurals: 2, plural_expression: '(n != 1)', entries: Array.from({ length: 71 }, (_, i) =>
    ({ id: 'p' + (i + 1), msgid: 'Item ' + i, forms: 1, concepts: ['sale'] })) };
  da.counts.php = 71;
  const big = setup('big', [packet('z', 60), da, packet('a', 10)]);
  const original = fs.readFileSync(path.join(big.workDir, 'da.json'), 'utf8');
  const chunks = planChunks(big);
  const partPaths = [1, 2].map(n => path.join(big.partsDir, `da.part${n}.json`));
  assert.deepEqual(chunks, [[path.join(big.workDir, 'a.json'), partPaths[0]], [partPaths[1], path.join(big.workDir, 'z.json')]]);
  for (const chunk of chunks) assert.ok(chunk.reduce((sum, file) => sum + read(file).counts.js + read(file).counts.php, 0) <= 250);
  const parts = partPaths.map(read);
  assert.deepEqual(parts.map(p => p.counts), [{ js: 186, php: 0 }, { js: 114, php: 71 }]);
  assert.deepEqual(parts.flatMap(items), items(da));
  assert.equal(new Set(parts.flatMap(items).map(([file, key]) => file + ':' + key)).size, 371);
  for (const [i, p] of parts.entries()) {
    for (const field of ['locale', 'locale_name', 'locale_notes', 'glossary', 'extra']) assert.deepEqual(p[field], da[field]);
    assert.deepEqual(items(p), items(da).slice(i === 0 ? 0 : 186, i === 0 ? 186 : 371));
    assert.equal(p.counts.js, Object.values(p.js).reduce((n, entries) => n + Object.keys(entries).length, 0));
    assert.equal(p.counts.php, Object.values(p.php).reduce((n, data) => n + data.entries.length, 0));
    assert.ok(Object.values(p.js).every(entries => Object.keys(entries).length > 0));
    for (const data of Object.values(p.php)) {
      assert.equal(data.nplurals, 2);
      assert.equal(data.plural_expression, '(n != 1)');
      assert.ok(data.entries.length > 0);
    }
    assert.equal(fs.readFileSync(partPaths[i], 'utf8'), JSON.stringify(p, null, 2) + '\n');
  }
  assert.equal(fs.readFileSync(path.join(big.workDir, 'da.json'), 'utf8'), original);
  for (const [name, counts, locales, expected] of [
    ['small', [100, 100, 60, 10], ['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']]],
    ['boundary', [250, 251], ['a', 'b'], [['a'], ['b.part1'], ['b.part2']]],
    ['greedy', [300, 100, 100, 60, 10], ['0', '1', '2', '3', '4'], [['0.part1'], ['0.part2', '1'], ['2', '3', '4']]],
  ]) {
    const dirs = setup(name, counts.map((n, i) => packet(locales[i], n)));
    assert.deepEqual(planChunks(dirs), expected.map(chunk => chunk.map(name =>
      path.join(name.includes('.part') ? dirs.partsDir : dirs.workDir, name + '.json'))));
    if (name === 'small') assert.ok(!fs.existsSync(dirs.partsDir));
    if (name === 'boundary') assert.deepEqual([1, 2].map(n => read(path.join(dirs.partsDir, `b.part${n}.json`)).counts.js), [126, 125]);
  }
  const relative = { workDir: path.relative('.', big.workDir), partsDir: path.relative('.', big.partsDir), max: 250 };
  const planned = planChunks(relative);
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/translate-chunks.js'),
    'plan', relative.workDir, relative.partsDir, '250'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, planned.map(chunk => chunk.join(' ')).join('\n') + '\n');
  assert.ok(planned.flat().every(file => !path.isAbsolute(file)));

  mergePartResults({ partsDir: path.join(root, 'absent'), resultsDir: big.resultsDir });
  const unsplit = '{ "locale": "a", "js": {} }\n';
  write(path.join(big.resultsDir, 'a.json'), unsplit);
  const results = parts.map(resultFor);
  results.forEach((result, i) => write(path.join(big.resultsDir, `da.part${i + 1}.json`), result));
  mergePartResults(big);
  const mergedPath = path.join(big.resultsDir, 'da.json');
  assert.deepEqual(read(mergedPath), resultFor(da));
  assert.equal(fs.readFileSync(mergedPath, 'utf8'), JSON.stringify(resultFor(da), null, 2) + '\n');
  for (const bad of ['{invalid', { ...results[1], locale: 'wrong' }, null, [], 7]) {
    write(path.join(big.resultsDir, 'da.part2.json'), bad);
    mergePartResults(big);
    assert.deepEqual(read(mergedPath), results[0]);
  }
  fs.unlinkSync(path.join(big.resultsDir, 'da.part2.json'));
  mergePartResults(big);
  assert.deepEqual(read(mergedPath), results[0]);
  write(path.join(big.resultsDir, 'da.part1.json'), null);
  fs.unlinkSync(mergedPath);
  mergePartResults(big);
  assert.ok(!fs.existsSync(mergedPath));
  assert.equal(fs.readFileSync(path.join(big.resultsDir, 'a.json'), 'utf8'), unsplit);

  const end = setup('apply', [packet('de_DE', 3)]);
  for (const file of planChunks({ ...end, max: 2 }).flat()) write(path.join(end.resultsDir, path.basename(file)), resultFor(read(file)));
  mergePartResults(end);
  const report = applyTranslations({ ...end, rootDir: path.join(root, 'apply') });
  assert.equal(report.applied, 3);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(report.missing_results, []);
  assert.deepEqual(read(path.join(root, 'apply/translations/js/de_DE/app/x.json')), resultFor(packet('de_DE', 3)).js['app/x.json']);
  console.log('translate-chunks checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
