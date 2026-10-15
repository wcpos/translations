#!/usr/bin/env node

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    failed++;
  }
}

for (const name of ['receive-js-strings.yml', 'receive-php-strings.yml']) {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8');
  test(`${name} never interpolates client_payload in run blocks`, () => {
    const lines = workflow.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const run = line.match(/^( *)run: \|$/);
      if (!run) continue;
      for (const bodyLine of lines.slice(index + 1)) {
        if (bodyLine.trim() && bodyLine.match(/^ */)[0].length <= run[1].length) break;
        assert.ok(!bodyLine.includes('client_payload'), `Payload expression in run block: ${bodyLine}`);
      }
    }
  });
  test(`${name} limits GITHUB_TOKEN to contents: read`, () => {
    assert.match(workflow, /^permissions:\n  contents: read\n/m);
    assert.doesNotMatch(workflow, /^\s*contents: write\s*$/m);
  });

  if (name !== 'receive-js-strings.yml') continue;
  const steps = workflow.match(/      - name: [^\n]*\n(?:(?!      - name:)[\s\S])*/g) || [];
  const validation = steps.find(step => step.startsWith('      - name: Validate payload\n'));
  assert.ok(validation, 'JS Validate payload step not found');
  const lines = validation.split(/\r?\n/);
  const runIndex = lines.indexOf('        run: |');
  assert.notStrictEqual(runIndex, -1, 'Validate payload run block not found');
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

  for (const [label, env, accepted] of [
    ['accepts monorepo main', { REPO: 'monorepo', REF: 'translations-source', LANE: 'main' }, true],
    ['accepts electron next', { REPO: 'electron', REF: 'translations-source-next', LANE: 'next' }, true],
    ['accepts pro main', { REPO: 'woocommerce-pos-pro', REF: 'translations-source', LANE: 'main' }, true],
    ['rejects shell syntax in repo', { REPO: 'monorepo; touch pwned', REF: 'translations-source', LANE: 'main' }, false],
    ['rejects unknown repo', { REPO: 'other-repo', REF: 'translations-source', LANE: 'main' }, false],
    ['rejects main ref', { REPO: 'monorepo', REF: 'main', LANE: 'main' }, false],
    ['rejects git options in ref', { REPO: 'monorepo', REF: 'translations-source --upload-pack=touch pwned', LANE: 'main' }, false],
    ['rejects dev lane', { REPO: 'monorepo', REF: 'translations-source', LANE: 'dev' }, false],
  ]) {
    test(`JS payload ${label}`, () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'receive-payload-'));
      try {
        const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script.join('\n')], {
          cwd: tempRoot,
          encoding: 'utf8',
          env: { ...process.env, ...env },
        });
        assert.ifError(result.error);
        if (accepted) {
          assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`);
        } else {
          assert.notStrictEqual(result.status, 0);
          assert.match(`${result.stdout}${result.stderr}`, /::error::/);
        }
        assert.ok(!fs.existsSync(path.join(tempRoot, 'pwned')), 'Payload executed a shell command');
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
