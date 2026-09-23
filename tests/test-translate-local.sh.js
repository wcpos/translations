#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const script = path.resolve(__dirname, '../scripts/translate-local.sh');
const source = fs.readFileSync(script, 'utf8');
const syntax = spawnSync('/bin/bash', ['-n', script], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);
for (const forbidden of ['--force', 'push origin main', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'gpt-5.6']) {
  assert.ok(!source.includes(forbidden), forbidden);
}
for (const required of ['gpt-6-luna', 'gpt-6-sol', '--review-model', 'TRANSLATE_REVIEW_MODEL']) {
  assert.ok(source.includes(required), required);
}
assert.match(source, /^#!\/bin\/bash\nset -euo pipefail/);
assert.ok(fs.statSync(script).mode & 0o111);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translate-local-')));
const bin = path.join(root, 'bin');
const wt = path.join(root, '.claude/worktrees/auto-translate');
const packets = path.join(root, 'packets');
const copy = path.join(root, 'translate-local.sh');
const callsFile = path.join(root, 'calls.jsonl');
const env = { ...process.env, TMPDIR: root, TRANSLATE_REPO_ROOT: root };
for (const key of ['TRANSLATE_LOCAL_REEXEC', 'TRANSLATE_CHUNK_SELFTEST', 'TRANSLATE_TRANSLATOR', 'TRANSLATE_MODEL', 'TRANSLATE_REVIEW_MODEL', 'TRANSLATE_EFFORT']) delete env[key];
const readCalls = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const isCall = (call, tool, ...args) => call.tool === tool && args.every(arg => call.args.includes(arg));
function run(config = {}, args = [], overrides = {}) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(callsFile, '');
  const result = spawnSync('/bin/bash', [copy, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 120000 });
  assert.ifError(result.error);
  return { ...result, calls: readCalls() };
}
try {
  for (const dir of [bin, packets, path.join(wt, 'scripts')]) fs.mkdirSync(dir, { recursive: true });
  for (const [index, count] of [300, 100, 100, 60, 10].entries()) {
    fs.writeFileSync(path.join(packets, String(index) + '.json'), JSON.stringify({ counts: { js: count - 1, php: 1 } }));
  }
  const chunked = spawnSync(script, [packets], { env: { ...env, TRANSLATE_CHUNK_SELFTEST: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(chunked.status, 0, chunked.stderr);
  assert.deepEqual(chunked.stdout.trim().split('\n'), ['0', '1 2', '3 4']);
  fs.writeFileSync(path.join(wt, 'scripts/translate-prompt.md'), 'TRANSLATE\n');
  fs.writeFileSync(path.join(wt, 'scripts/review-prompt.md'), 'REVIEW\n');
  // Only redirect command lookup and shorten the timeout in this isolated copy.
  fs.writeFileSync(copy, source.replace(/^PATH=.*$/m, 'PATH=' + JSON.stringify(bin) + ':$PATH').replace('CALL_TIMEOUT=1800', 'CALL_TIMEOUT=1'));
  const stub = String.raw`#!@NODE@
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.dirname(__dirname), tool = path.basename(process.argv[1]), args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const wt = path.join(root, '.claude/worktrees/auto-translate');
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ tool, args, cwd: process.cwd() }) + '\n');
if (tool === 'git') {
  if (args.includes('show')) {
    if (!config.reexec) process.exit(1);
    process.stdout.write(fs.readFileSync(path.join(root, 'translate-local.sh'), 'utf8') + '\n# updated\n');
  }
  if (args.includes('list')) console.log('worktree ' + wt);
  if (args.includes('status') && fs.existsSync('.translate/accepted')) console.log(' M translations/js/bb/app.json');
  if (args.includes('merge') && !args.includes('--abort') && config.conflict) process.exit(1);
} else if (tool === 'gh') {
  if (args[1] === 'list' && config.pr) console.log(JSON.stringify(config.pr));
  if (args[1] === 'create' && args[0] === 'pr') console.log('https://example.test/pr/1');
} else if (tool === 'node') {
  if (args[0] === '-e') {
    const r = cp.spawnSync(process.execPath, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);
  } else if (args[0].endsWith('translation-worklist.js')) {
    const counter = '.translate/worklist-count';
    const call = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    const counts = (call === 1 ? config.counts || [2, 1] : config.remainingCounts || []), locales = {};
    const out = args[args.lastIndexOf('--out') + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(counter, String(call));
    counts.forEach((n, i) => {
      const locale = ['aa', 'bb'][i]; locales[locale] = { js: n, php: 0 };
      fs.writeFileSync(path.join(out, locale + '.json'), JSON.stringify({ locale, counts: locales[locale], source: config.packetSource || 'original' }));
    });
    console.log(JSON.stringify({ total: counts.reduce((a, b) => a + b, 0), locales }));
  } else if (args[0].endsWith('apply-translations.js')) {
    const locales = fs.readdirSync('.translate/results').filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
    const report = { applied: locales.length, files_written: locales.map(l => 'translations/js/' + l + '/app.json') };
    fs.writeFileSync('.translate/report.json', JSON.stringify(report));
    fs.writeFileSync('.translate/report.md', 'REPORT\n');
    if (locales.length) fs.writeFileSync('.translate/accepted', '');
    console.log(JSON.stringify({ applied: locales.length, rejected: 0, warnings: 0, files: locales.length }));
  } else if (args[0].endsWith('validate-translations.js')) process.exit(config.invalid ? 1 : 0);
  else if (args[0].endsWith('check-translation-quality.js')) console.log('QUALITY');
  else if (args[0].endsWith('check-completeness.js')) console.log('Details\nErrors:   0\nWarnings: 2');
  else process.exit(99);
} else if (tool === 'codex' || tool === 'claude') {
  const prompt = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ tool: 'prompt', prompt }) + '\n');
  if (config.fail && prompt.includes('/aa.json')) process.exit(1);
  if (config.failReview && prompt.startsWith('REVIEW')) process.exit(1);
  if (config.hang) {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'child.pid'), String(child.pid));
    setInterval(() => {}, 1000);
  } else {
    for (const match of prompt.matchAll(/-> (\.translate\/results\/(\w+)\.json)/g)) fs.writeFileSync(match[1], JSON.stringify({ locale: match[2] }));
  }
}
`.replace('@NODE@', process.execPath);
  for (const tool of ['git', 'gh', 'pnpm', 'node', 'codex', 'claude']) fs.writeFileSync(path.join(bin, tool), stub, { mode: 0o755 });
  let result = run({ counts: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to translate/);
  assert.ok(!result.calls.some(c => ['codex', 'claude'].includes(c.tool)));
  result = run({ reexec: true }, ['--dry-run', '--base', 'stack', '--locale', 'bb']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).total, 3);
  assert.equal(result.calls.filter(c => isCall(c, 'git', 'show')).length, 1);
  assert.equal(result.calls.filter(c => isCall(c, 'git', 'fetch')).length, 2);
  assert.ok(result.calls.some(c => isCall(c, 'git', 'checkout', 'origin/stack')));
  assert.ok(result.calls.some(c => isCall(c, 'node', '--locale', 'bb')));
  assert.ok(!result.calls.some(c => ['codex', 'claude'].includes(c.tool)));
  result = run({ fail: true }, ['--max-per-call', '1', '--base', 'stack', '--translator', 'codex', '--model', 'chosen', '--review-model', 'chosen-review', '--effort', 'high'], { TRANSLATE_TRANSLATOR: 'claude', TRANSLATE_MODEL: 'env-model', TRANSLATE_REVIEW_MODEL: 'env-review', TRANSLATE_EFFORT: 'low' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter(c => c.tool === 'codex').length, 3);
  assert.ok(result.calls.filter(c => c.tool === 'codex').every(c => c.cwd === wt && c.args.includes('model_reasoning_effort="high"')));
  assert.deepEqual(result.calls.filter(c => c.tool === 'codex').map(c => c.args[c.args.indexOf('-m') + 1]), ['chosen', 'chosen', 'chosen-review']);
  assert.match(fs.readFileSync(path.join(wt, '.translate/pr-body.md'), 'utf8'), /Applied 1 strings for 1 locales \(bb\); translator: codex \(chosen\); review: chosen-review\.[\s\S]*REPORT[\s\S]*QUALITY[\s\S]*Errors:   0[\s\S]*Warnings: 2[\s\S]*Generated by scripts\/translate-local.sh/);
  assert.ok(result.calls.some(c => isCall(c, 'gh', 'pr', 'create', '--base', 'stack')));
  assert.ok(result.calls.some(c => isCall(c, 'git', 'push', '--quiet', '-u', 'origin')));
  assert.ok(result.calls.filter(c => isCall(c, 'git', 'reset') || isCall(c, 'git', 'clean') || isCall(c, 'git', 'checkout')).every(c => c.cwd === wt));
  const pr = { number: 42, headRefName: 'auto-translate/existing', url: 'https://example.test/pr/42' };
  result = run({ pr, failReview: true }, ['--translator', 'claude']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.filter(c => c.tool === 'claude').every(c => c.args.includes('sonnet')));
  assert.ok(result.calls.some(c => isCall(c, 'gh', 'comment', '42')));
  assert.ok(result.calls.some(c => isCall(c, 'git', 'merge', 'origin/main')));
  assert.match(result.stdout, /review 1 failed/);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.filter(c => c.tool === 'codex').map(c => c.args[c.args.indexOf('-m') + 1]), ['gpt-6-luna', 'gpt-6-sol']);
  assert.match(fs.readFileSync(path.join(wt, '.translate/pr-body.md'), 'utf8'), /translator: codex \(gpt-6-luna\); review: gpt-6-sol\./);
  for (const translator of ['codex', 'claude']) {
    result = run({}, ['--translator', translator], { TRANSLATE_MODEL: 'env-model', TRANSLATE_REVIEW_MODEL: 'env-review' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.filter(c => c.tool === translator).map(c => c.args[c.args.indexOf(translator === 'codex' ? '-m' : '--model') + 1]), ['env-model', 'env-review']);
  }
  result = run({ invalid: true }, ['--no-review']);
  assert.equal(result.status, 1);
  assert.ok(!result.calls.some(c => isCall(c, 'git', 'commit') || isCall(c, 'git', 'push')));
  assert.equal(result.calls.filter(c => c.tool === 'codex').length, 1);
  result = run({ pr, conflict: true });
  assert.equal(result.status, 1);
  assert.ok(result.calls.some(c => isCall(c, 'git', 'merge', '--abort')));
  assert.ok(!result.calls.some(c => c.tool === 'pnpm'));
  for (const branch of ['main', 'stack']) {
    result = run({ pr: { ...pr, headRefName: branch } }, ['--base', 'stack', '--no-review']);
    assert.equal(result.status, 1);
    assert.ok(!result.calls.some(c => isCall(c, 'git', 'push')));
    assert.match(fs.readFileSync(path.join(wt, '.translate/pr-body.md'), 'utf8'), /translator: codex \(gpt-6-luna\); review: skipped\./);
  }
  result = run({ counts: [1], hang: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /chunk 1 failed or timed out/);
  assert.match(result.stdout, /no translations accepted/);
  assert.throws(() => process.kill(Number(fs.readFileSync(path.join(root, 'child.pid'))), 0), { code: 'ESRCH' });
  fs.writeFileSync(callsFile, '');
  const locked = spawnSync('/bin/bash', ['-c', 'exec 9>"$1"; /usr/bin/lockf -s -t 0 9; /bin/bash "$2" 9>&-', 'test', path.join(root, '.claude/auto-translate.lock'), copy], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(locked.status, 0, locked.stderr);
  assert.match(locked.stdout, /already running/);
  assert.ok(!readCalls().some(c => isCall(c, 'git', 'reset')));
  assert.ok(fs.existsSync(path.join(root, '.claude/auto-translate.lock')));
  const state = path.join(root, '.claude/auto-translate.state');
  const started = Math.floor(Date.now() / 1000);
  result = run({ counts: [1], remainingCounts: [1], fail: true }, ['--no-review', '--locale', 'aa']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /no translations accepted/);
  const recorded = fs.readFileSync(state, 'utf8');
  const lines = recorded.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(Number(lines[0]) >= started && Number(lines[0]) <= Math.floor(Date.now() / 1000));
  for (const [i, dir] of ['work', 'remaining'].entries()) {
    const folder = path.join(wt, '.translate', dir);
    const content = fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort().map(f => fs.readFileSync(path.join(folder, f), 'utf8')).join('');
    assert.equal(lines[i + 1], createHash('sha256').update(content).digest('hex'));
  }
  assert.ok(result.calls.some(c => isCall(c, 'node', 'scripts/translation-worklist.js', '--out', '.translate/remaining', '--locale', 'aa')));
  for (const translator of ['codex', 'claude']) {
    result = run({ counts: [1] }, ['--translator', translator]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /same work as an unsuccessful run at .*Z; skipping the model until .*Z \(pass --retry to override\)/);
    assert.ok(!result.calls.some(c => ['codex', 'claude'].includes(c.tool)));
    assert.equal(fs.readFileSync(state, 'utf8'), recorded);
  }
  result = run({ counts: [1], remainingCounts: [1] }, ['--retry']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(c => c.tool === 'codex'));
  result = run({ counts: [1], remainingCounts: [1], packetSource: 'changed' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(c => c.tool === 'codex'));
  const changed = fs.readFileSync(state, 'utf8').trim().split('\n');
  assert.notEqual(changed[1], lines[1]);
  changed[0] = String(Math.floor(Date.now() / 1000) - 86401);
  fs.writeFileSync(state, changed.join('\n') + '\n');
  result = run({ counts: [1], remainingCounts: [1], packetSource: 'changed' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(c => c.tool === 'codex'));
  result = run({ counts: [2, 1], remainingCounts: [1], invalid: true }, ['--no-review']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /validation failed/);
  const partial = fs.readFileSync(state, 'utf8').trim().split('\n');
  assert.equal(partial.length, 3);
  assert.notEqual(partial[1], partial[2]);
  result = run({ counts: [1] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipping the model/);
  assert.ok(!result.calls.some(c => ['codex', 'claude'].includes(c.tool)));
  result = run({ counts: [1], remainingCounts: [] }, ['--retry']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.some(c => c.tool === 'codex'));
  assert.ok(!fs.existsSync(state));
  console.log('translate-local checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
