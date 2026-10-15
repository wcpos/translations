#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { mergeJson, mergePo, resolveLaneConflicts } = require('../scripts/resolve-lane-conflicts');
const { parsePoFile, generateL10nPhp } = require('../scripts/po-file');

const jsonFile = 'translations/js/da/app/core.json';
const poFile = 'translations/php/da/app.po';
const phpFile = poFile.replace(/\.po$/, '.l10n.php');
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

for (const deletedLane of ['next', 'main']) {
  scenario(`${deletedLane} deletes JSON and PO; next determines files and committed PHP`, {
    base: { [jsonFile]: '{"shared":"Base"}', [poFile]: 'msgid "Shared"\nmsgstr "Base"\n', [phpFile]: 'Base PHP\n' },
    main: { [jsonFile]: deletedLane === 'main' ? null : mainJson, [poFile]: deletedLane === 'main' ? null : mainPo,
      [phpFile]: 'Main changed PHP\n' },
    next: { [jsonFile]: deletedLane === 'next' ? null : nextJson, [poFile]: deletedLane === 'next' ? null : nextPo,
      [phpFile]: deletedLane === 'next' ? null : 'Next committed PHP\n' },
  }, ({ cwd, git, read }) => {
    resolveLaneConflicts({ cwd });
    assert.equal(git('ls-files', '-u'), '');
    if (deletedLane === 'next') {
      for (const file of [jsonFile, poFile, phpFile]) assert.ok(!fs.existsSync(path.join(cwd, file)));
    } else {
      assert.equal(read(jsonFile), nextJson);
      assert.equal(read(poFile), nextPo);
      assert.equal(read(phpFile), 'Next committed PHP\n');
    }
  });
}
