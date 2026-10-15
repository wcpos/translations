#!/usr/bin/env node

// Run the actual sync-next merge step against local Git remotes so source
// conflicts keep next's side and conflicts elsewhere still stop the sync.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/sync-next.yml');
const POT = 'source/php/woocommerce-pos.pot';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function pot(msgid) {
  return `msgid ""\nmsgstr ""\n\nmsgid "${msgid}"\nmsgstr ""\n`;
}

function mergeStepScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const stepIndex = lines.indexOf('      - name: Merge main into next');
  const runIndex = lines.indexOf('        run: |', stepIndex);
  assert.notStrictEqual(stepIndex, -1, 'Merge main into next step not found');
  assert.notStrictEqual(runIndex, -1, 'Merge run block not found');

  const script = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.startsWith('          ')) {
      script.push(line.slice(10));
    } else if (line === '') {
      script.push('');
    } else {
      break;
    }
  }
  return script.join('\n');
}

function scenario(name, { base, main, next, expectSuccess = true }, verify) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-next-'));
  try {
    const remote = path.join(tempRoot, 'remote.git');
    const seed = path.join(tempRoot, 'seed');
    const runner = path.join(tempRoot, 'runner');
    const fakeBin = path.join(tempRoot, 'bin');

    run('git', ['init', '--bare', '--initial-branch=main', remote], tempRoot);
    run('git', ['init', '--initial-branch=main', seed], tempRoot);
    run('git', ['config', 'user.name', 'Test Runner'], seed);
    run('git', ['config', 'user.email', 'test@example.com'], seed);
    run('git', ['remote', 'add', 'origin', remote], seed);

    for (const [lane, files] of Object.entries({ base, main, next })) {
      if (lane !== 'base') run('git', ['checkout', lane], seed);
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(seed, file);
        if (content === null) {
          fs.unlinkSync(target);
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content);
        }
      }
      run('git', ['add', '-A'], seed);
      run('git', ['commit', '-m', lane], seed);
      if (lane === 'base') run('git', ['branch', 'next'], seed);
    }
    run('git', ['push', 'origin', 'main', 'next'], seed);
    run('git', ['clone', remote, runner], tempRoot);
    const nextBefore = run('git', ['rev-parse', 'origin/next'], runner);

    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(fakeBin, 'sleep'), 0o755);

    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', mergeStepScript()], {
      cwd: runner,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.ifError(result.error);
    assert.notStrictEqual(result.status, null, `${name}: step terminated by signal\n${output}`);
    if (expectSuccess) {
      assert.strictEqual(result.status, 0, `${name}: Merge step failed:\n${output}`);
    } else {
      assert.notStrictEqual(result.status, 0, `${name}: Merge step unexpectedly succeeded:\n${output}`);
    }

    run('git', ['fetch', 'origin', 'main', 'next'], runner);
    verify({ runner, output, nextBefore });
    console.log(`✓ ${name}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

scenario('Source conflict resolves to next', {
  base: { [POT]: pot('Base') },
  main: { [POT]: pot('Main'), 'translations/js/da/a.json': '{"a":"Main"}\n' },
  next: { [POT]: pot('Next') },
}, ({ runner, output, nextBefore }) => {
  const parents = run('git', ['log', '-1', '--format=%P', 'origin/next'], runner).split(' ');
  assert.strictEqual(parents.length, 2, 'next should be a merge commit');
  assert.strictEqual(parents[0], nextBefore, 'first parent should be the previous next');
  assert.strictEqual(parents[1], run('git', ['rev-parse', 'origin/main'], runner));
  const mergedPot = run('git', ['show', `origin/next:${POT}`], runner);
  assert.ok(mergedPot.includes('msgid "Next"'), 'next should keep its POT');
  assert.ok(!mergedPot.includes('msgid "Main"'), 'main should not replace next\'s POT');
  assert.strictEqual(run('git', ['cat-file', '-e', 'origin/next:translations/js/da/a.json'], runner), '');
  assert.ok(output.includes('::notice::Kept next\'s side'), 'source resolution notice missing');
});

scenario('Conflict outside source fails', {
  base: { [POT]: pot('Base'), 'translations/js/da/b.json': '{"b":"Base"}\n' },
  main: {
    [POT]: pot('Main'),
    'translations/js/da/a.json': '{"a":"Main"}\n',
    'translations/js/da/b.json': '{"b":"Main"}\n',
  },
  next: { [POT]: pot('Next'), 'translations/js/da/b.json': '{"b":"Next"}\n' },
  expectSuccess: false,
}, ({ runner, output, nextBefore }) => {
  assert.ok(output.includes('::error::Merge conflicts:'), 'merge conflict error missing');
  assert.strictEqual(run('git', ['rev-parse', 'origin/next'], runner), nextBefore, 'next must not move');
});

scenario('Clean merge', {
  base: { 'unrelated.txt': 'Base\n' },
  main: { 'translations/js/da/c.json': '{"c":"Main"}\n' },
  next: { 'unrelated.txt': 'Next\n' },
}, ({ runner, output }) => {
  assert.strictEqual(run('git', ['cat-file', '-e', 'origin/next:translations/js/da/c.json'], runner), '');
  assert.ok(!output.includes('::notice::Kept'), 'clean merge should not report source resolution');
});

scenario('Next deleted a source file main changed', {
  base: { 'source/js/old.json': '{"old":"Base"}\n' },
  main: { 'source/js/old.json': '{"old":"Main"}\n' },
  next: { 'source/js/old.json': null },
}, ({ runner }) => {
  assert.strictEqual(
    run('git', ['ls-tree', '--name-only', 'origin/next', '--', 'source/js/old.json'], runner),
    '',
    'next\'s deleted source file should remain absent'
  );
});
