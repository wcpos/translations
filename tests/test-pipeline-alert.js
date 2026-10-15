#!/usr/bin/env node

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/pipeline-alert.yml'), 'utf8');

function check(name, verify) {
  verify();
  console.log(`✓ ${name}`);
}

check('monitors the five pipeline workflows in order without a branch filter', () => {
  const names = ['Receive JS Strings', 'Receive PHP Strings', 'Sync main into next', 'Release', 'Publish next lane'];
  assert.ok(workflow.includes(`    workflows: [${names.map(name => `'${name}'`).join(', ')}]`));
  assert.ok(!/^\s+branches(?:-ignore)?:/m.test(workflow));
});

check('runs when a workflow completes', () => {
  assert.match(workflow, /^on:\n  workflow_run:\n/m);
  assert.match(workflow, /^    types: \[completed\]$/m);
});

check('alerts only on failure', () => {
  assert.match(workflow, /^  alert:\n    if: github\.event\.workflow_run\.conclusion == 'failure'$/m);
});

check('grants only issues write permission', () => {
  const permissions = workflow.match(/^permissions:\n((?:  [^\n]*\n)+)/m);
  assert.ok(permissions, 'top-level permissions not found');
  assert.strictEqual(permissions[1], '  issues: write\n');
  assert.ok(!/contents:\s*write/.test(workflow));
});

// Exercise the actual shell shipped in the workflow.
const lines = workflow.split(/\r?\n/);
const stepIndex = lines.indexOf('      - name: Open or update pipeline issue');
assert.notStrictEqual(stepIndex, -1, 'alert step not found');
const runIndex = lines.indexOf('        run: |', stepIndex);
assert.notStrictEqual(runIndex, -1, 'alert run block not found');
const scriptLines = [];
for (const line of lines.slice(runIndex + 1)) {
  if (line.startsWith('          ')) {
    scriptLines.push(line.slice(10));
  } else if (line === '') {
    scriptLines.push('');
  } else {
    break;
  }
}
const script = scriptLines.join('\n');

check('run block contains no GitHub expressions', () => {
  assert.ok(script.trim(), 'run block is empty');
  assert.ok(!script.includes('${{'));
});

if (spawnSync('bash', ['--noprofile', '--norc', '-c', 'command -v jq']).status !== 0) {
  console.log('SKIP pipeline alert behaviour checks: jq is not on PATH');
  process.exit(0);
}

function scenario(name, issues, verify) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-alert-'));
  try {
    const fakeBin = path.join(tempRoot, 'bin');
    const log = path.join(tempRoot, 'gh.log');
    const listJson = path.join(tempRoot, 'issues.json');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(listJson, JSON.stringify(issues));
    // JSON-escape each argument so multiline bodies still occupy one log line.
    fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, args.map(arg => JSON.stringify(arg)).join('\t') + '\\n');
if (args[0] === 'issue' && args[1] === 'list') {
  process.stdout.write(fs.readFileSync(process.env.GH_LIST_JSON));
}
`, { mode: 0o755 });

    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        GH_LOG: log,
        GH_LIST_JSON: listJson,
        GH_TOKEN: 'test',
        GH_REPO: 'test/translations',
        WORKFLOW: 'Release',
        RUN_URL: 'https://example.test/run/1',
        BRANCH: 'main',
        SHA: 'abc123',
        EVENT: 'push',
      },
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map(line => line.split('\t').map(arg => JSON.parse(arg)));
    verify(calls);
    console.log(`✓ ${name}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

scenario('no open issue creates a labelled pipeline issue', [], calls => {
  assert.ok(calls.some(args => args.slice(0, 3).join(' ') === 'label create pipeline'));
  const create = calls.find(args => args[0] === 'issue' && args[1] === 'create');
  assert.ok(create, 'issue create call missing');
  assert.strictEqual(create[create.indexOf('--title') + 1], 'Pipeline failure: Release');
  assert.strictEqual(create[create.indexOf('--label') + 1], 'pipeline');
  assert.strictEqual(create[create.indexOf('--body') + 1], [
    'Workflow: Release', 'Branch: main', 'SHA: abc123', 'Triggering event: push',
    'Run URL: https://example.test/run/1',
    'This issue stays open until someone closes it after the fix.',
  ].join('\n'));
  assert.ok(!calls.some(args => args[0] === 'issue' && args[1] === 'comment'));
});

scenario('same workflow comments on its existing issue', [
  { number: 7, title: 'Pipeline failure: Sync main into next' },
  { number: 12, title: 'Pipeline failure: Release' },
], calls => {
  const comment = calls.find(args => args[0] === 'issue' && args[1] === 'comment');
  assert.ok(comment, 'issue comment call missing');
  assert.strictEqual(comment[2], '12');
  assert.ok(comment[comment.indexOf('--body') + 1].includes('https://example.test/run/1'));
  assert.ok(!calls.some(args => args[0] === 'issue' && args[1] === 'create'));
});

scenario('another workflow issue does not prevent creation', [
  { number: 7, title: 'Pipeline failure: Sync main into next' },
], calls => {
  assert.ok(calls.some(args => args[0] === 'issue' && args[1] === 'create'));
  assert.ok(!calls.some(args => args[0] === 'issue' && args[1] === 'comment'));
});
