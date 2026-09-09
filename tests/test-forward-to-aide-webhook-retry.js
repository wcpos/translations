#!/usr/bin/env node

// The forward-to-aide webhook POST must never be re-sent after the gateway
// has answered. On 2026-09-09 the gateway answered 502 after it had already
// spawned the translation run, and curl's `--retry` (which treats 5xx as
// transient) re-posted three more times — four duplicate Aide runs per push.
// Only a transport failure (the server was never reached) may be retried.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/forward-to-aide.yml');

function webhookScript() {
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

  const start = script.findIndex(line => line.startsWith('echo "Forwarding to Aide:'));
  const end = script.findIndex(line => line.startsWith('node scripts/wait-for-openclaw-task.js'));
  assert.notStrictEqual(start, -1, 'forward echo boundary not found');
  assert.notStrictEqual(end, -1, 'wait-for-openclaw-task boundary not found');
  return script.slice(start, end).join('\n');
}

// A fake curl that records every invocation and answers per FAKE_CURL_MODE:
//   http-502        — the server answered 502 {"error":"dispatch_failed"}
//   refuse-then-202 — first call cannot connect (exit 7), second answers 202
//   timeout-28      — the request timed out (exit 28); the server may have
//                     received it, so this must not be retried either
function writeFakeCurl(binDir, callLog) {
  const curl = path.join(binDir, 'curl');
  fs.writeFileSync(curl, `#!/bin/bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --retry) echo "curl --retry re-posts on HTTP 5xx; the workflow must not use it" >&2; exit 98 ;;
    *) shift ;;
  esac
done
echo call >> "${callLog}"
calls=$(wc -l < "${callLog}" | tr -d ' ')
case "$FAKE_CURL_MODE" in
  http-502)
    printf '%s' '{"error":"dispatch_failed"}' > "$out"
    printf '502'
    exit 0 ;;
  refuse-then-202)
    if [ "$calls" -eq 1 ]; then exit 7; fi
    printf '%s' '{"accepted":true,"job_id":"j","poll_url":"/api/tasks/j"}' > "$out"
    printf '202'
    exit 0 ;;
  timeout-28)
    exit 28 ;;
esac
echo "unknown FAKE_CURL_MODE" >&2
exit 99
`);
  fs.chmodSync(curl, 0o755);
}

function scenario(mode, expect) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forward-to-aide-retry-'));
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir);
  writeFakeCurl(binDir, path.join(tempRoot, 'calls.log'));
  const fakeSleep = path.join(binDir, 'sleep');
  fs.writeFileSync(fakeSleep, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeSleep, 0o755);

  const script = [
    'project=woocommerce-pos',
    'type=php',
    'file_count=1',
    "changed_files='[\"source/php/woocommerce-pos.pot\"]'",
    "payload='{}'",
    webhookScript(),
  ].join('\n');

  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_CURL_MODE: mode,
      OPENCLAW_BASE_URL: 'http://aide.invalid',
      OPENCLAW_HOOKS_TOKEN: 'test-token',
    },
  });

  const calls = fs.existsSync(path.join(tempRoot, 'calls.log'))
    ? fs.readFileSync(path.join(tempRoot, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).length
    : 0;
  assert.strictEqual(result.status, expect.status, `${mode}: exit status\n${result.stdout}\n${result.stderr}`);
  assert.strictEqual(calls, expect.calls, `${mode}: curl invocations\n${result.stdout}\n${result.stderr}`);
  if (expect.stdoutMatch) {
    assert.match(result.stdout, expect.stdoutMatch, `${mode}: stdout`);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`  ok: ${mode}`);
}

console.log('forward-to-aide webhook retry policy');
scenario('http-502', { status: 1, calls: 1, stdoutMatch: /Aide webhook returned HTTP 502/ });
scenario('refuse-then-202', { status: 0, calls: 2, stdoutMatch: /http=202 status=accepted/ });
scenario('timeout-28', { status: 1, calls: 1, stdoutMatch: /request failed \(curl exit 28\)/ });
console.log('forward-to-aide webhook retry tests passed');
