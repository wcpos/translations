#!/usr/bin/env node

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/forward-to-aide.yml');
const CONTEXT_SUBJECT = 'chore: update PHP translation context artifacts';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
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

// Regenerate the context artifact the way the workflow does, so a competitor
// can push exactly the commit the runner is about to make.
function generateContext(cwd) {
  run(
    'node',
    [
      'scripts/translation-context-packets.js',
      '--type', 'php',
      '--locale', 'da_DK',
      '--domain', 'woocommerce-pos',
      '--out-dir', 'translation-context/php/da_DK',
    ],
    cwd
  );
}

function scenario(name, competitorPushes, verify) {
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
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(competitor, 'node_modules'), 'dir');
    const competitorShas = competitorPushes(competitor);

    fs.mkdirSync(fakeBin);
    const fakeSleep = path.join(fakeBin, 'sleep');
    fs.writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeSleep, 0o755);
    if (process.platform === 'darwin') {
      // BSD find has no -printf; emulate the two forms the workflow uses so
      // the test runs locally as well as on the Ubuntu runner.
      const fakeFind = path.join(fakeBin, 'find');
      fs.writeFileSync(
        fakeFind,
        `#!/usr/bin/env bash
args=(); fmt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-printf" ]; then fmt="$2"; shift 2; continue; fi
  args+=("$1"); shift
done
case "$fmt" in
  '%f\\n') exec /usr/bin/find "\${args[@]}" -exec basename {} ';' ;;
  ''|'%p\\n') exec /usr/bin/find "\${args[@]}" ;;
  *) echo "find shim: unsupported -printf $fmt" >&2; exit 1 ;;
esac
`
      );
      fs.chmodSync(fakeFind, 0o755);
    }

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
      `${name}: workflow prefix failed:\n${result.stdout || ''}${result.stderr || ''}`
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
      `${name}: pushed context artifact was not regenerated from the rebased PHP source`
    );
    verify({ runner, competitorShas, name });
    console.log(`✓ ${name}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

scenario(
  'regenerates PHP context after a rejected push rebases onto newer source',
  competitor => {
    writePot(path.join(competitor, 'source/php/woocommerce-pos.pot'), 'New source');
    run('git', ['add', 'source/php/woocommerce-pos.pot'], competitor);
    run('git', ['commit', '-m', 'update PHP source'], competitor);
    run('git', ['push'], competitor);
    return { source: run('git', ['rev-parse', 'HEAD'], competitor) };
  },
  ({ runner, competitorShas, name }) => {
    assert.strictEqual(
      run('git', ['rev-parse', 'origin/main^'], runner),
      competitorShas.source,
      `${name}: context commit should sit on top of the competitor's source commit`
    );
  }
);

// An earlier run already pushed the identical context artifacts, and a POT
// update landed on top. `git pull --rebase` drops our commit as previously
// applied, so HEAD is now someone else's published commit; regenerating
// against the new POT must produce a fresh commit, not amend that one.
scenario(
  'commits fresh instead of amending a published commit when the rebase drops ours',
  competitor => {
    generateContext(competitor);
    run('git', ['add', 'translation-context'], competitor);
    run('git', ['commit', '-m', CONTEXT_SUBJECT], competitor);
    writePot(path.join(competitor, 'source/php/woocommerce-pos.pot'), 'New source');
    run('git', ['add', 'source/php/woocommerce-pos.pot'], competitor);
    run('git', ['commit', '-m', 'chore: update free plugin source strings'], competitor);
    run('git', ['push'], competitor);
    return { source: run('git', ['rev-parse', 'HEAD'], competitor) };
  },
  ({ runner, competitorShas, name }) => {
    assert.strictEqual(
      run('git', ['rev-parse', 'origin/main^'], runner),
      competitorShas.source,
      `${name}: the competitor's source commit was rewritten`
    );
    assert.strictEqual(
      run('git', ['log', '-1', '--format=%s', 'origin/main'], runner),
      CONTEXT_SUBJECT,
      `${name}: regenerated artifacts should land under their own subject`
    );
    assert.strictEqual(
      run('git', ['diff', '--name-only', 'origin/main^', 'origin/main'], runner),
      'translation-context/php/da_DK/woocommerce-pos.context.json',
      `${name}: tip commit should contain only the context artifact`
    );
  }
);
