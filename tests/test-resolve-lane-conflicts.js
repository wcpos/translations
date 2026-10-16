#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mergeJson, mergePo, resolveLaneConflicts } = require('../scripts/resolve-lane-conflicts');
const { parsePoFile, generateL10nPhp, compileMo } = require('../scripts/po-file');

const jsonFile = 'translations/js/da/app/core.json';
const poFile = 'translations/php/da/app.po';
const phpFile = poFile.replace(/\.po$/, '.l10n.php');
const moFile = poFile.replace(/\.po$/, '.mo');
const laneBasePo = 'msgid "Shared"\nmsgstr "Base"\n';
const moOf = text => { const p = parsePoFile(text); return compileMo(p.entries, p.header); };
const nextJson = '{"shared":"Next","nextOnly":"Next only","empty":"","__proto__":"data"}';
const mainJson = '{"shared":"Main","mainOnly":"Main only","empty":"Main filled"}';
const nextPo = [
  'msgid ""\nmsgstr ""\n"Language: da\\n"\n"X-Lane: next\\n"',
  '#. Next plural\n#: next.php:1\n#, php-format\nmsgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] "%d next"\nmsgstr[1] "%d next plural"',
  '# Next comment\n#: next.php:2\n#, fuzzy\nmsgid "Shared"\nmsgstr "Next fuzzy"',
  'msgctxt "next context"\nmsgid "Context"\nmsgstr "Next context value"',
  'msgid "Next only"\nmsgstr "Next only value"',
].join('\n\n') + '\n';
const mainPo = [
  'msgid ""\nmsgstr ""\n"Language: da\\n"\n"X-Lane: main\\n"',
  '#. Main plural\n#: main.php:1\nmsgid "%d item"\nmsgid_plural "%d items"\nmsgstr[0] "%d main"\nmsgstr[1] "%d main plural"',
  '# Main comment\nmsgid "Shared"\nmsgstr "Main non-fuzzy"',
  '#. Main-only comment\n#: main.php:3\n#, fuzzy\nmsgid "Main only"\nmsgstr "Main fuzzy"',
  'msgctxt "main context"\nmsgid "Context"\nmsgstr "Main context value"',
].join('\n\n') + '\n';
const nextParsed = parsePoFile(nextPo);
const mainParsed = parsePoFile(mainPo);
const merged = mergePo(nextPo, mainPo);
const expectedEntries = [...nextParsed.entries, ...mainParsed.entries.slice(2)];
const expectedL10n = generateL10nPhp(expectedEntries, nextParsed.header);

const json = mergeJson(nextJson, mainJson);
const values = JSON.parse(json);
assert.equal(values.shared, 'Next');
assert.equal(values.mainOnly, 'Main only');
assert.equal(values.nextOnly, 'Next only');
assert.equal(values.empty, '');
assert.deepEqual(Object.keys(values), Object.keys(values).sort());
assert.ok(json.endsWith('\n'));
assert.equal(json, JSON.stringify(values, null, 2) + '\n');
assert.equal(mergeJson(nextJson, mainJson), json);
assert.equal(mergeJson(nextJson, '{"empty":"Main filled","mainOnly":"Main only","shared":"Main"}'), json);
assert.ok(Object.hasOwn(values, '__proto__'));
assert.equal(values.__proto__, 'data');
console.log('✓ JSON next-wins union, empty values, sorted stable bytes and __proto__');

const parsed = parsePoFile(merged.po);
assert.deepEqual(parsed.entries, expectedEntries);
assert.deepEqual(parsed.entries[0].msgstr_plural, ['%d next', '%d next plural']);
assert.ok(parsed.entries[1].flags.includes('fuzzy'));
assert.equal(parsed.entries[1].msgstr, 'Next fuzzy');
assert.ok(parsed.entries[4].flags.includes('fuzzy'));
assert.deepEqual(parsed.entries.map(entry => entry.msgid), ['%d item', 'Shared', 'Context', 'Next only', 'Main only', 'Context']);
assert.equal(parsed.header, nextParsed.header);
assert.equal(merged.l10n, expectedL10n);
const phpCheck = "$r = require $argv[1]; exit(is_array($r) && isset($r['messages']) && is_array($r['messages']) ? 0 : 1);";
const phpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-php-'));
try {
  const file = path.join(phpDir, 'merged.l10n.php');
  fs.writeFileSync(file, merged.l10n);
  execFileSync('php', ['-r', phpCheck, file]);
} finally {
  fs.rmSync(phpDir, { recursive: true, force: true });
}
console.log('✓ PO whole entries, plurals, flags, contexts, next header and loadable PHP');

{
  const baseJson = '{"a":"A","b":"B","c":"C","d":"D","e":"E","__proto__":"P"}';
  const nextJson = '{"b":"B","c":"Cn","e":"En","g":"G","__proto__":"P"}';
  const mainJson = '{"a":"A","c":"Cm","d":"Dm","f":"F"}';
  const json = mergeJson(nextJson, mainJson, baseJson);
  const values = JSON.parse(json);
  assert.deepEqual(values, { c: 'Cn', e: 'En', f: 'F', g: 'G' });
  assert.deepEqual(Object.keys(values), ['c', 'e', 'f', 'g']);
  assert.ok(!Object.hasOwn(values, '__proto__'));
  console.log('✓ JSON three-way keeps deletions from either lane');

  const basePo = [
    'msgid ""\nmsgstr ""\n"Language: da\\n"\n"X-Lane: base\\n"',
    'msgid "Deleted on next"\nmsgstr "Base"',
    'msgid "Deleted on main"\nmsgstr "Base"',
    '#: base.php:1\nmsgid "Reference only"\nmsgstr "Base"',
    'msgid "Fuzzy on next"\nmsgstr "Base"',
    'msgid "Shared"\nmsgstr "Base"',
    'msgid "Changed on main"\nmsgstr "Base"',
  ].join('\n\n') + '\n';
  const nextPo = [
    'msgid ""\nmsgstr ""\n"Language: da\\n"\n"X-Lane: next\\n"',
    'msgid "Deleted on main"\nmsgstr "Base"',
    '#: next.php:2\nmsgid "Reference only"\nmsgstr "Base"',
    '#, fuzzy\nmsgid "Fuzzy on next"\nmsgstr "Base"',
    '# Next comment\n#: next.php:3\nmsgid "Shared"\nmsgstr "Next"',
  ].join('\n\n') + '\n';
  const mainPo = [
    'msgid ""\nmsgstr ""\n"Language: da\\n"\n"X-Lane: main\\n"',
    'msgid "Deleted on next"\nmsgstr "Base"',
    '# Main comment\n#: main.php:3\nmsgid "Shared"\nmsgstr "Main"',
    'msgid "Changed on main"\nmsgstr "Main"',
    'msgid "Main only"\nmsgstr "Added"',
  ].join('\n\n') + '\n';
  const nextParsed = parsePoFile(nextPo);
  const mainParsed = parsePoFile(mainPo);
  const merged = mergePo(nextPo, mainPo, basePo);
  const parsed = parsePoFile(merged.po);
  assert.deepEqual(parsed.entries.map(entry => entry.msgid), ['Fuzzy on next', 'Shared', 'Main only']);
  assert.deepEqual(parsed.entries, [...nextParsed.entries.slice(2), mainParsed.entries[3]]);
  assert.equal(parsed.header, nextParsed.header);
  assert.equal(merged.l10n, generateL10nPhp(parsed.entries, nextParsed.header));
  console.log('✓ PO three-way keeps deletions from either lane');

  scenario('Three-way: a deletion on either lane stays deleted', {
    base: { [jsonFile]: baseJson, [poFile]: basePo },
    main: { [jsonFile]: mainJson, [poFile]: mainPo },
    next: { [jsonFile]: nextJson, [poFile]: nextPo },
  }, ({ cwd, git, read }) => {
    assert.notEqual(git('ls-files', '-u', '--', jsonFile), '');
    assert.notEqual(git('ls-files', '-u', '--', poFile), '');
    resolveLaneConflicts({ cwd });
    assert.equal(git('ls-files', '-u'), '');
    assert.equal(read(jsonFile), mergeJson(nextJson, mainJson, baseJson));
    const expected = mergePo(nextPo, mainPo, basePo);
    assert.equal(read(poFile), expected.po);
    assert.equal(read(phpFile), expected.l10n);
    const values = JSON.parse(read(jsonFile));
    assert.ok(!Object.hasOwn(values, 'a'));
    assert.ok(!Object.hasOwn(values, 'b'));
    const msgids = parsePoFile(read(poFile)).entries.map(entry => entry.msgid);
    assert.ok(!msgids.includes('Deleted on next'));
    assert.ok(!msgids.includes('Deleted on main'));
    execFileSync('php', ['-r', phpCheck, path.join(cwd, phpFile)]);
  });
}

function scenario(name, { base, main, next }, verify) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-conflicts-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const read = file => fs.readFileSync(path.join(cwd, file), 'utf8');
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Test Runner');
    git('config', 'user.email', 'test@example.com');
    for (const [lane, files] of Object.entries({ base, main, next })) {
      if (lane !== 'base') git('checkout', lane);
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(cwd, file);
        if (content === null) fs.unlinkSync(target);
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content);
        }
      }
      git('add', '-A');
      git('commit', '-m', lane);
      if (lane === 'base') git('branch', 'next');
    }
    const result = spawnSync('git', ['merge', '--no-edit', 'main'], { cwd, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.notEqual(git('ls-files', '-u'), '');
    verify({ cwd, git, read });
    console.log(`✓ ${name}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

scenario('Real JSON, PO, PHP and source conflicts resolve together', {
  base: { [jsonFile]: '{"shared":"Base"}', [poFile]: 'msgid "Shared"\nmsgstr "Base"\n',
    [phpFile]: '<?php return array();\n', 'source/js/a.json': 'Base\n' },
  main: { [jsonFile]: mainJson, [poFile]: mainPo,
    [phpFile]: generateL10nPhp(mainParsed.entries, mainParsed.header), 'source/js/a.json': 'Main\n' },
  next: { [jsonFile]: nextJson, [poFile]: nextPo,
    [phpFile]: generateL10nPhp(nextParsed.entries, nextParsed.header), 'source/js/a.json': 'Next\n' },
}, ({ cwd, git, read }) => {
  const { resolved } = resolveLaneConflicts({ cwd });
  assert.deepEqual(resolved.sort(), [jsonFile, poFile, phpFile, 'source/js/a.json'].sort());
  assert.equal(git('ls-files', '-u'), '');
  assert.equal(read(jsonFile), json);
  assert.equal(read(poFile), merged.po);
  assert.equal(read(phpFile), expectedL10n);
  assert.equal(read('source/js/a.json'), 'Next\n');
  execFileSync('php', ['-r', phpCheck, path.join(cwd, phpFile)]);
});

for (const disallowed of ['README.md', 'translations/php/da/x.mo', 'translations/php/da/orphan.l10n.php']) {
  scenario(`Reject ${disallowed} before writing any path`, {
    base: { [jsonFile]: '{"shared":"Base"}', [disallowed]: 'Base\n' },
    main: { [jsonFile]: mainJson, [disallowed]: 'Main\n' },
    next: { [jsonFile]: nextJson, [disallowed]: 'Next\n' },
  }, ({ cwd, git, read }) => {
    const before = read(jsonFile);
    const index = git('ls-files', '-u', '-z');
    assert.throws(() => resolveLaneConflicts({ cwd }), error => error.message.includes(disallowed));
    assert.equal(read(jsonFile), before);
    assert.equal(git('ls-files', '-u', '-z'), index);
    assert.notEqual(git('ls-files', '-u', '--', jsonFile), '');
  });
}

scenario('A PHP-only conflict regenerates from the working PO', {
  base: { [poFile]: nextPo, [phpFile]: 'Base\n' },
  main: { [phpFile]: 'Main\n' },
  next: { [phpFile]: 'Next\n' },
}, ({ cwd, git, read }) => {
  assert.deepEqual(resolveLaneConflicts({ cwd }).resolved, [phpFile]);
  assert.equal(read(poFile), nextPo);
  assert.equal(read(phpFile), generateL10nPhp(nextParsed.entries, nextParsed.header));
  assert.equal(git('ls-files', '-u'), '');
});

scenario('PO and MO conflicts regenerate the MO from the merged PO', {
  base: { [poFile]: laneBasePo, [moFile]: moOf(laneBasePo) },
  main: { [poFile]: mainPo, [moFile]: moOf(mainPo) },
  next: { [poFile]: nextPo, [moFile]: moOf(nextPo) },
}, ({ cwd, git, read }) => {
  assert.deepEqual(resolveLaneConflicts({ cwd }).resolved.sort(), [moFile, poFile].sort());
  assert.equal(git('ls-files', '-u'), '');
  assert.ok(fs.readFileSync(path.join(cwd, moFile)).equals(moOf(read(poFile))));
  assert.equal(git('diff', '--name-only', '--', moFile), '');
});

scenario('A PO conflict regenerates an MO that did not conflict', {
  base: { [poFile]: laneBasePo, [moFile]: moOf(laneBasePo) },
  main: { [poFile]: mainPo },
  next: { [poFile]: nextPo, [moFile]: moOf(nextPo) },
}, ({ cwd, git, read }) => {
  assert.deepEqual(resolveLaneConflicts({ cwd }).resolved, [poFile]);
  assert.ok(fs.readFileSync(path.join(cwd, moFile)).equals(moOf(read(poFile))));
  assert.ok(!fs.readFileSync(path.join(cwd, moFile)).equals(moOf(nextPo)));
  assert.equal(git('diff', '--name-only', '--', moFile), '');
});

scenario('An MO-only conflict regenerates from the working PO', {
  base: { [poFile]: nextPo, [moFile]: 'Base\n' },
  main: { [moFile]: 'Main\n' },
  next: { [moFile]: 'Next\n' },
}, ({ cwd, git, read }) => {
  assert.deepEqual(resolveLaneConflicts({ cwd }).resolved, [moFile]);
  assert.equal(read(poFile), nextPo);
  assert.ok(fs.readFileSync(path.join(cwd, moFile)).equals(moOf(nextPo)));
  assert.equal(git('ls-files', '-u'), '');
});

for (const deletedLane of ['next', 'main']) {
  scenario(`${deletedLane} deletes JSON and PO; next determines files and committed PHP`, {
    base: { [jsonFile]: '{"shared":"Base"}', [poFile]: 'msgid "Shared"\nmsgstr "Base"\n', [phpFile]: 'Base PHP\n', [moFile]: 'Base MO\n' },
    main: { [jsonFile]: deletedLane === 'main' ? null : mainJson, [poFile]: deletedLane === 'main' ? null : mainPo,
      [phpFile]: 'Main changed PHP\n', [moFile]: 'Main changed MO\n' },
    next: { [jsonFile]: deletedLane === 'next' ? null : nextJson, [poFile]: deletedLane === 'next' ? null : nextPo,
      [phpFile]: deletedLane === 'next' ? null : 'Next committed PHP\n', [moFile]: deletedLane === 'next' ? null : 'Next committed MO\n' },
  }, ({ cwd, git, read }) => {
    resolveLaneConflicts({ cwd });
    assert.equal(git('ls-files', '-u'), '');
    if (deletedLane === 'next') {
      for (const file of [jsonFile, poFile, phpFile, moFile]) assert.ok(!fs.existsSync(path.join(cwd, file)));
    } else {
      assert.equal(read(jsonFile), nextJson);
      assert.equal(read(poFile), nextPo);
      assert.equal(read(phpFile), 'Next committed PHP\n');
      assert.equal(read(moFile), 'Next committed MO\n');
    }
  });
}
