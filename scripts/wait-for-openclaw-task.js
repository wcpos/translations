#!/usr/bin/env node

const fs = require('node:fs');

const DEFAULT_BASE_URL = 'https://openclaw.wcpos.com';
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_SUCCESS_STATUS = 'completed';
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'relay_failed']);

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read OpenClaw response file ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`OpenClaw response file ${filePath} does not contain valid JSON: ${error.message}`);
  }
}

function parseAcceptedJob(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('OpenClaw webhook response must be a JSON object');
  }

  if (payload.accepted !== true) {
    const detail = payload.error ? `: ${payload.error}` : '';
    throw new Error(`OpenClaw webhook did not report an accepted job${detail}`);
  }

  const jobId = typeof payload.job_id === 'string' ? payload.job_id.trim() : '';
  const pollUrl = typeof payload.poll_url === 'string' ? payload.poll_url.trim() : '';

  if (!jobId || !pollUrl) {
    throw new Error('Accepted OpenClaw response must include job_id and poll_url');
  }

  return { jobId, pollUrl };
}

function resolvePollUrl(pollUrl, baseUrl = DEFAULT_BASE_URL) {
  try {
    return new URL(pollUrl, baseUrl).toString();
  } catch (error) {
    throw new Error(`Invalid poll_url returned by OpenClaw: ${error.message}`);
  }
}

function maybeParseJson(value) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatTaskDetails(task) {
  const details = [];

  if (task.error) {
    details.push(`error=${task.error}`);
  }

  const parsedOutput = maybeParseJson(task.output);
  if (parsedOutput && typeof parsedOutput === 'object') {
    details.push(`output=${JSON.stringify(parsedOutput)}`);
  } else if (typeof parsedOutput === 'string' && parsedOutput.trim()) {
    details.push(`output=${parsedOutput.trim()}`);
  }

  return details.length > 0 ? details.join(' ') : 'no details';
}

async function readJsonResponse(response) {
  if (typeof response.json === 'function') {
    return response.json();
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    return JSON.parse(text);
  }
  throw new Error('OpenClaw task response does not support json() or text()');
}

async function pollTaskUntilTerminal({
  pollUrl,
  apiToken,
  fetchImpl = globalThis.fetch,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
  createTimeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? (ms) => AbortSignal.timeout(ms)
    : () => undefined,
}) {
  if (!pollUrl) {
    throw new Error('pollUrl is required');
  }
  if (!apiToken) {
    throw new Error('TRANSLATION_STATUS_TOKEN or OPENCLAW_API_TOKEN is required to poll OpenClaw task status');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to poll OpenClaw task status');
  }

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastStatus = null;

  while (true) {
    attempt += 1;

    let response;
    try {
      response = await fetchImpl(pollUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Failed to poll OpenClaw task at ${pollUrl}: ${error.message}`);
    }

    if (!response.ok) {
      throw new Error(`OpenClaw task poll failed with HTTP ${response.status}`);
    }

    let task;
    try {
      task = await readJsonResponse(response);
    } catch (error) {
      throw new Error(`OpenClaw task poll did not return valid JSON: ${error.message}`);
    }

    const status = typeof task?.status === 'string' ? task.status.trim() : '';
    if (!status) {
      throw new Error('OpenClaw task payload is missing a status field');
    }

    if (status !== lastStatus) {
      logger.log(`OpenClaw task status: ${status} (attempt ${attempt})`);
      lastStatus = status;
    }

    if (status === TERMINAL_SUCCESS_STATUS) {
      logger.log(`OpenClaw task reached terminal success: ${formatTaskDetails(task)}`);
      return task;
    }

    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      throw new Error(`OpenClaw task ended with status ${status}: ${formatTaskDetails(task)}`);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for OpenClaw task at ${pollUrl} to reach a terminal state; last status=${status}`);
    }

    await sleep(intervalMs);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const responsePath = argv[0];
  if (!responsePath) {
    throw new Error('Usage: node scripts/wait-for-openclaw-task.js <response-json-path>');
  }

  const payload = readJsonFile(responsePath);
  const { jobId, pollUrl } = parseAcceptedJob(payload);
  const baseUrl = env.OPENCLAW_BASE_URL || DEFAULT_BASE_URL;
  const apiToken = env.TRANSLATION_STATUS_TOKEN || env.OPENCLAW_API_TOKEN || '';
  const intervalMs = Number.parseInt(env.OPENCLAW_POLL_INTERVAL_MS || '', 10);
  const timeoutMs = Number.parseInt(env.OPENCLAW_POLL_TIMEOUT_MS || '', 10);
  const resolvedPollUrl = resolvePollUrl(pollUrl, baseUrl);

  console.log(`OpenClaw accepted translation job ${jobId}`);
  console.log(`Polling OpenClaw task URL: ${resolvedPollUrl}`);

  const task = await pollTaskUntilTerminal({
    pollUrl: resolvedPollUrl,
    apiToken,
    intervalMs: Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : DEFAULT_INTERVAL_MS,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });

  console.log(`OpenClaw job ${jobId} finished with status ${task.status}`);
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  formatTaskDetails,
  main,
  parseAcceptedJob,
  pollTaskUntilTerminal,
  readJsonFile,
  resolvePollUrl,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
