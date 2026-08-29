#!/usr/bin/env node

// The receive-php-strings Commit step runs from a checkout pinned to the
// dispatch SHA. If anything lands on main between checkout and push (forward-
// to-aide's context-artifact commit does, about a minute after every receive)
// a bare `git push` is rejected and the POT update is lost. This runs the real
// step script against a bare remote where a competitor has already pushed.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/receive-php-strings.yml');
const POT = 'source/php/woocommerce-pos.pot';
const CONTEXT = 'translation-context/php/da_DK/woocommerce-pos.context.json';

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function pot(msgid) {
  return `msgid ""\nmsgstr ""\n\nmsgid "${msgid}"\nmsgstr ""\n`;
}

// Extract the receive-free job's Commit step from the workflow so the test
// exercises the shell that actually ships.
function commitStepScript(force) {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const jobIndex = lines.indexOf('  receive-free:');
  const stepIndex = lines.indexOf('      - name: Commit', jobIndex);
  const runIndex = lines.indexOf('        run: |', stepIndex);
  assert.notStrictEqual(jobIndex, -1, 'receive-free job not found');
  assert.notStrictEqual(stepIndex, -1, 'receive-free Commit step not found');
  assert.notStrictEqual(runIndex, -1, 'Commit run block not found');

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
  return script
    .join('\n')
    .replace(/\$\{\{ github\.event\.client_payload\.force \}\}/g, force ? 'true' : 'false')
    // The step points origin at a tokenised GitHub URL; keep the test's bare remote.
    .replace(/^git remote set-url origin .*$/m, ':');
}

function scenario(name, { competitorPot = null, runnerPot, expectPush }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'receive-pot-race-'));
  try {
    const remote = path.join(tempRoot, 'remote.git');
    const runner = path.join(tempRoot, 'runner');
    const competitor = path.join(tempRoot, 'competitor');
    const fakeBin = path.join(tempRoot, 'bin');
    const runnerTemp = path.join(tempRoot, 'runner-temp');
    const output = path.join(tempRoot, 'github-output');
    fs.mkdirSync(runnerTemp);

    run('git', ['init', '--bare', '--initial-branch=main', remote], tempRoot);
    run('git', ['init', '--initial-branch=main', runner], tempRoot);
    fs.mkdirSync(path.join(runner, 'source/php'), { recursive: true });
    fs.writeFileSync(path.join(runner, POT), pot('Old source'));
    run('git', ['config', 'user.name', 'Test Runner'], runner);
    run('git', ['config', 'user.email', 'test@example.com'], runner);
    run('git', ['remote', 'add', 'origin', remote], runner);
    run('git', ['add', 'source'], runner);
    run('git', ['commit', '-m', 'initial source'], runner);
    run('git', ['push', '-u', 'origin', 'main'], runner);

    // Something else lands on main after the runner's checkout.
    run('git', ['clone', remote, competitor], tempRoot);
    run('git', ['config', 'user.name', 'Competing Runner'], competitor);
    run('git', ['config', 'user.email', 'competitor@example.com'], competitor);
    fs.mkdirSync(path.dirname(path.join(competitor, CONTEXT)), { recursive: true });
    fs.writeFileSync(path.join(competitor, CONTEXT), '{"entries":[]}\n');
    if (competitorPot) {
      fs.writeFileSync(path.join(competitor, POT), pot(competitorPot));
    }
    run('git', ['add', '-A'], competitor);
    run('git', ['commit', '-m', 'chore: update PHP translation context artifacts'], competitor);
    run('git', ['push'], competitor);
    const competitorSha = run('git', ['rev-parse', 'HEAD'], competitor);

    // The Fetch POT step has already overwritten the file in the checkout.
    fs.writeFileSync(path.join(runner, POT), pot(runnerPot));

    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(fakeBin, 'sleep'), 0o755);

    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', commitStepScript(false)], {
      cwd: runner,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_TOKEN: 'test',
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: runnerTemp,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    assert.strictEqual(
      result.status,
      0,
      `${name}: Commit step failed:\n${result.stdout || ''}${result.stderr || ''}`
    );

    run('git', ['fetch', 'origin', 'main'], runner);
    const mainPot = run('git', ['show', `origin/main:${POT}`], runner);
    assert.ok(mainPot.includes(`msgid "${runnerPot}"`), `${name}: POT on main is not the received one`);
    assert.strictEqual(
      run('git', ['cat-file', '-e', `origin/main:${CONTEXT}`], runner),
      '',
      `${name}: competitor's files are missing from main`
    );
    assert.ok(
      fs.readFileSync(output, 'utf8').includes('changed=true'),
      `${name}: expected changed=true so the forward still runs`
    );

    if (expectPush) {
      assert.strictEqual(
        run('git', ['log', '-1', '--format=%s', 'origin/main'], runner),
        'chore: update free plugin source strings',
        `${name}: tip commit subject`
      );
      assert.strictEqual(
        run('git', ['rev-parse', 'origin/main^'], runner),
        competitorSha,
        `${name}: received POT should sit on top of the competitor's commit`
      );
    } else {
      assert.strictEqual(
        run('git', ['rev-parse', 'origin/main'], runner),
        competitorSha,
        `${name}: nothing should be pushed when the POT is already on main`
      );
    }
    console.log(`✓ ${name}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

scenario('re-stages the POT on top of a commit that landed after checkout', {
  runnerPot: 'New source',
  expectPush: true,
});

scenario('skips the push when the retry finds the same POT already on main', {
  competitorPot: 'New source',
  runnerPot: 'New source',
  expectPush: false,
});
