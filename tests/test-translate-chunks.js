#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { planChunks } = require('../scripts/translate-chunks');
const { applyTranslations } = require('../scripts/apply-translations');
const { parsePoFile } = require('../scripts/po-file');

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

  // Plural siblings stay together: the group at items 124-127 would straddle the 126 boundary.
  const plurals = packet('pl', 251);
  const plural = plurals.js['app/x.json'];
  const sibling = {};
  for (const [i, suffix] of ['one', 'few', 'many', 'other'].entries()) sibling['g_' + suffix] = plural['k' + (124 + i)];
  plurals.js['app/x.json'] = Object.fromEntries(Object.entries(plural).flatMap(([key, entry]) =>
    key === 'k124' ? Object.entries(sibling) : /^k12[567]$/.test(key) ? [] : [[key, entry]]));
  const grouped = setup('plural', [plurals]);
  planChunks(grouped);
  const groupParts = [1, 2].map(n => read(path.join(grouped.partsDir, `pl.part${n}.json`)));
  assert.ok(groupParts.every(p => p.counts.js <= 250));
  assert.deepEqual(groupParts.flatMap(items), items(plurals));
  const groupKeys = ['g_one', 'g_few', 'g_many', 'g_other'];
  assert.equal(groupParts.filter(p => groupKeys.some(key => key in p.js['app/x.json'])).length, 1);
  assert.ok(groupParts.some(p => groupKeys.every(key => key in p.js['app/x.json'])));
  const plain = setup('plain', [packet('pn', 251)]);
  planChunks(plain);
  assert.deepEqual([1, 2].map(n => read(path.join(plain.partsDir, `pn.part${n}.json`)).counts.js), [126, 125]);

  // Part-aware apply: a locale with two parts (2 JS keys and 6 PHP entries, max 5 gives 4 + 4).
  const split = {
    ...packet('da', 2), counts: { js: 2, php: 6 },
    php: { shop: { nplurals: 2, plural_expression: '(n != 1)', entries: Array.from({ length: 6 }, (_, i) =>
      ({ id: 'p' + (i + 1), msgid: 'Item ' + i, forms: 1, concepts: [] })) } },
  };
  const pot = split.php.shop.entries.map(entry => `msgid "${entry.msgid}"\nmsgstr ""\n`).join('\n');
  const jsOut = 'translations/js/da/app/x.json', poOut = 'translations/php/da/shop-da.po';
  function scenario(name, mutate) {
    const dirs = setup(name, [split]);
    const rootDir = path.join(root, name);
    fs.mkdirSync(path.join(rootDir, 'source/php'), { recursive: true });
    write(path.join(rootDir, 'source/php/shop.pot'), pot);
    planChunks({ ...dirs, max: 5 });
    const partResults = [1, 2].map(n => resultFor(read(path.join(dirs.partsDir, `da.part${n}.json`))));
    partResults.forEach((result, i) => write(path.join(dirs.resultsDir, `da.part${i + 1}.json`), result));
    mutate?.(dirs, partResults);
    return { dirs, rootDir, partResults, report: applyTranslations({ ...dirs, rootDir }) };
  }
  const translated = rootDir => parsePoFile(fs.readFileSync(path.join(rootDir, poOut), 'utf8')).entries.map(entry => entry.msgstr);
  let scene = scenario('apply-a');
  assert.equal(scene.report.applied, 8);
  assert.deepEqual(scene.report.rejected, []);
  assert.deepEqual(scene.report.missing_results, []);
  assert.equal(scene.report.unexpected, 0);
  assert.deepEqual(read(path.join(scene.rootDir, jsOut)), { k0: 'Oversat k0', k1: 'Oversat k1' });
  assert.deepEqual(translated(scene.rootDir), Array(6).fill('Oversat'));
  const partFile = (dirs, n) => path.join(dirs.resultsDir, `da.part${n}.json`);
  scene = scenario('apply-b', (dirs, [, second]) => write(partFile(dirs, 2), {
    ...second, js: { 'app/x.json': { k0: 'Forkert' } }, php: { ...second.php, p1: ['Forkert'] },
  }));
  assert.equal(scene.report.unexpected, 2);
  assert.deepEqual(read(path.join(scene.rootDir, jsOut)), { k0: 'Oversat k0', k1: 'Oversat k1' });
  assert.deepEqual(translated(scene.rootDir), Array(6).fill('Oversat'));
  const part2Items = ['Item 2', 'Item 3', 'Item 4', 'Item 5'];
  for (const [name, bad] of [['apply-c', '{invalid'], ['apply-d', { locale: 'wrong', js: {}, php: {} }]]) {
    scene = scenario(name, dirs => write(partFile(dirs, 2), bad));
    assert.deepEqual(scene.report.rejected.map(r => r.key), part2Items);
    assert.ok(scene.report.rejected.every(r => r.reasons.length === 1 && r.reasons[0] === 'invalid results file (da.part2)'));
    assert.equal(scene.report.applied, 4);
    assert.deepEqual(read(path.join(scene.rootDir, jsOut)), { k0: 'Oversat k0', k1: 'Oversat k1' });
  }
  scene = scenario('apply-e', dirs => fs.unlinkSync(partFile(dirs, 2)));
  assert.deepEqual(scene.report.rejected.map(r => [r.key, r.reasons]), part2Items.map(key => [key, ['no translation returned']]));
  assert.equal(scene.report.applied, 4);
  assert.deepEqual(scene.report.missing_results, []);
  scene = scenario('apply-f', dirs => [1, 2].forEach(n => fs.unlinkSync(partFile(dirs, n))));
  assert.deepEqual(scene.report.missing_results, ['da']);
  assert.deepEqual(scene.report.rejected, []);
  scene = scenario('apply-g');
  fs.rmSync(path.join(scene.rootDir, 'translations'), { recursive: true });
  const applyCli = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/apply-translations.js'),
    '--work', scene.dirs.workDir, '--results', scene.dirs.resultsDir, '--parts', scene.dirs.partsDir,
    '--root', scene.rootDir], { encoding: 'utf8' });
  assert.equal(applyCli.status, 0, applyCli.stderr);
  assert.equal(JSON.parse(applyCli.stdout).applied, 8);
  console.log('translate-chunks checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
