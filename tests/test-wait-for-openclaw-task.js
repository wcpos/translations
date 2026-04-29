#!/usr/bin/env node

const assert = require('node:assert/strict');

const {
  DEFAULT_TIMEOUT_MS,
  parseAcceptedJob,
  pollTaskUntilTerminal,
} = require('../scripts/wait-for-openclaw-task');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('allows long-running translation batches by default', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 20 * 60 * 1000);
});

test('requires job_id and poll_url on accepted responses', async () => {
  assert.throws(
    () => parseAcceptedJob({ accepted: true }),
    /job_id and poll_url/
  );
});

test('returns normalized job metadata for accepted responses', async () => {
  assert.deepEqual(
    parseAcceptedJob({ accepted: true, job_id: 'translation:123', poll_url: '/api/tasks/translation:123' }),
    {
      jobId: 'translation:123',
      pollUrl: '/api/tasks/translation:123',
    }
  );
});

test('polls until completed status', async () => {
  const seenUrls = [];
  const result = await pollTaskUntilTerminal({
    pollUrl: 'https://openclaw.example/api/tasks/translation:123',
    apiToken: 'secret-token',
    fetchImpl: async (url, options = {}) => {
      seenUrls.push(String(url));
      assert.equal(options.headers.Authorization, 'Bearer secret-token');
      return {
        ok: true,
        status: 200,
        async json() {
          return seenUrls.length === 1
            ? { status: 'running' }
            : { status: 'completed', output: '{"status":"ok","summary":"done"}' };
        },
      };
    },
    intervalMs: 0,
    timeoutMs: 100,
    sleep: async () => {},
    logger: { log() {} },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.output, '{"status":"ok","summary":"done"}');
  assert.deepEqual(seenUrls, [
    'https://openclaw.example/api/tasks/translation:123',
    'https://openclaw.example/api/tasks/translation:123',
  ]);
});

test('uses a fixed per-request timeout instead of poll interval length', async () => {
  const seenTimeouts = [];

  await pollTaskUntilTerminal({
    pollUrl: 'https://openclaw.example/api/tasks/translation:signal',
    apiToken: 'secret-token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { status: 'completed', output: '{"status":"ok"}' };
      },
    }),
    intervalMs: 60_000,
    timeoutMs: 100,
    sleep: async () => {},
    logger: { log() {} },
    createTimeoutSignal: (ms) => {
      seenTimeouts.push(ms);
      return { timeoutMs: ms };
    },
  });

  assert.deepEqual(seenTimeouts, [30_000]);
});

test('throws on failed terminal status with task details', async () => {
  await assert.rejects(
    () => pollTaskUntilTerminal({
      pollUrl: 'https://openclaw.example/api/tasks/translation:456',
      apiToken: 'secret-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'failed',
            error: 'translation completion reported error',
            output: '{"status":"error","errors":[{"locale":"fr_FR","error":"bad placeholders"}]}',
          };
        },
      }),
      intervalMs: 0,
      timeoutMs: 100,
      sleep: async () => {},
      logger: { log() {} },
    }),
    /failed.*translation completion reported error.*bad placeholders/s
  );
});

test('main requires TRANSLATION_STATUS_TOKEN for polling', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../scripts/wait-for-openclaw-task');

  const responsePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-response-')), 'response.json');
  fs.writeFileSync(responsePath, JSON.stringify({
    accepted: true,
    job_id: 'translation:cli',
    poll_url: '/api/tasks/translation:cli',
  }));

  await assert.rejects(
    () => main([responsePath], { OPENCLAW_BASE_URL: 'https://openclaw.example' }),
    /TRANSLATION_STATUS_TOKEN.*OPENCLAW_API_TOKEN/
  );
});

test('main does not log duplicate terminal task details', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { main } = require('../scripts/wait-for-openclaw-task');

  const responsePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-response-')), 'response.json');
  fs.writeFileSync(responsePath, JSON.stringify({
    accepted: true,
    job_id: 'translation:cli-logs',
    poll_url: '/api/tasks/translation:cli-logs',
  }));

  const originalFetch = global.fetch;
  const originalConsoleLog = console.log;
  const capturedLogs = [];

  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        status: 'completed',
        output: '{"status":"ok","summary":"done"}',
      };
    },
  });
  console.log = (...args) => {
    capturedLogs.push(args.join(' '));
  };

  try {
    await main([responsePath], {
      OPENCLAW_BASE_URL: 'https://openclaw.example',
      TRANSLATION_STATUS_TOKEN: 'secret-token',
      OPENCLAW_POLL_INTERVAL_MS: '0',
      OPENCLAW_POLL_TIMEOUT_MS: '100',
    });
  } finally {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
  }

  const detailLogs = capturedLogs.filter((line) => line.includes('output={"status":"ok","summary":"done"}'));
  assert.deepEqual(detailLogs, [
    'OpenClaw task reached terminal success: output={"status":"ok","summary":"done"}',
  ]);
  assert.ok(capturedLogs.includes('OpenClaw job translation:cli-logs finished with status completed'));
});

test('throws when polling times out before terminal status', async () => {
  await assert.rejects(
    () => pollTaskUntilTerminal({
      pollUrl: 'https://openclaw.example/api/tasks/translation:789',
      apiToken: 'secret-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { status: 'running' };
        },
      }),
      intervalMs: 0,
      timeoutMs: 0,
      sleep: async () => {},
      logger: { log() {} },
    }),
    /Timed out waiting for OpenClaw task/
  );
});

async function main() {
  console.log('Testing OpenClaw task polling');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
