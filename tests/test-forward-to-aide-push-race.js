#!/usr/bin/env node

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/forward-to-aide.yml');

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' });
}

function writePot(filePath, msgid) {
  fs.writeFileSync(filePath, `msgid ""
msgstr ""
"Project-Id-Version: WooCommerce POS\\n"

#: includes/example.php:1
msgid "${msgid}"
msgstr ""
`);
}

function workflowPrefix() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const stepIndex = lines.indexOf('      - name: Forward to Aide webhook');
  const runIndex = lines.indexOf('        run: |', stepIndex);
  assert.notStrictEqual(stepIndex, -1, 'Forward to Aide webhook step not found');
  assert.notStrictEqual(runIndex, -1, 'Forward to Aide webhook run block not found');

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

  const payloadIndex = script.findIndex(line => line.startsWith('source_ref='));
  assert.notStrictEqual(payloadIndex, -1, 'source_ref boundary not found');
  return script
    .slice(0, payloadIndex)
    .join('\n')
    .replace(/\$\{\{ inputs\.project \}\}/g, 'woocommerce-pos')
    .replace(/\$\{\{ inputs\.type \}\}/g, 'php');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-context-race-'));

try {
  const remote = path.join(tempRoot, 'remote.git');
  const runner = path.join(tempRoot, 'runner');
  const competitor = path.join(tempRoot, 'competitor');
  const fakeBin = path.join(tempRoot, 'bin');

  run('git', ['init', '--bare', '--initial-branch=main', remote], tempRoot);
  run('git', ['init', '--initial-branch=main', runner], tempRoot);

  fs.mkdirSync(path.join(runner, 'source/php'), { recursive: true });
  fs.mkdirSync(path.join(runner, 'translations/php/da_DK'), { recursive: true });
  fs.mkdirSync(path.join(runner, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'scripts/translation-context-packets.js'),
    path.join(runner, 'scripts/translation-context-packets.js')
  );
  fs.copyFileSync(
    path.join(ROOT, 'scripts/translation-concepts.json'),
    path.join(runner, 'scripts/translation-concepts.json')
  );
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(runner, 'node_modules'), 'dir');

  writePot(path.join(runner, 'source/php/woocommerce-pos.pot'), 'Old source');
  fs.writeFileSync(
    path.join(runner, 'translations/php/da_DK/woocommerce-pos-da_DK.po'),
    `msgid ""
msgstr ""
"Language: da_DK\\n"
`
  );

  run('git', ['config', 'user.name', 'Test Runner'], runner);
  run('git', ['config', 'user.email', 'test@example.com'], runner);
  run('git', ['remote', 'add', 'origin', remote], runner);
  run('git', ['add', 'source', 'translations', 'scripts'], runner);
  run('git', ['commit', '-m', 'initial source'], runner);
  run('git', ['push', '-u', 'origin', 'main'], runner);

  run('git', ['clone', remote, competitor], tempRoot);
  run('git', ['config', 'user.name', 'Competing Runner'], competitor);
  run('git', ['config', 'user.email', 'competitor@example.com'], competitor);
  writePot(path.join(competitor, 'source/php/woocommerce-pos.pot'), 'New source');
  run('git', ['add', 'source/php/woocommerce-pos.pot'], competitor);
  run('git', ['commit', '-m', 'update PHP source'], competitor);
  run('git', ['push'], competitor);

  fs.mkdirSync(fakeBin);
  const fakeSleep = path.join(fakeBin, 'sleep');
  fs.writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeSleep, 0o755);

  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', workflowPrefix()],
    {
      cwd: runner,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENCLAW_HOOKS_TOKEN: 'test',
        TRANSLATION_STATUS_TOKEN: 'test',
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    }
  );
  assert.strictEqual(
    result.status,
    0,
    `workflow prefix failed:\n${result.stdout || ''}${result.stderr || ''}`
  );

  run('git', ['fetch', 'origin', 'main'], runner);
  const artifact = JSON.parse(
    run(
      'git',
      ['show', 'origin/main:translation-context/php/da_DK/woocommerce-pos.context.json'],
      runner
    )
  );
  assert.ok(
    artifact.entries.some(packet => packet.entry.msgid === 'New source'),
    'pushed context artifact was not regenerated from the rebased PHP source'
  );

  console.log('✓ regenerates PHP context after a rejected push rebases onto newer source');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
