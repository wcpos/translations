#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/recover-results.js');
const RECOVERED = /^recovered (\S+) from the translator's last message$/;

// Builds a temp dir with packets and an optional message file, runs the script, and reports what it wrote.
function recover({ packets, message, existing = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-results-'));
  try {
    const results = path.join(dir, '.translate/results');
    fs.mkdirSync(results, { recursive: true });
    const packetPaths = Object.entries(packets).map(([rel, locale]) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ locale, counts: { js: 1, php: 0 }, js: { 'app/x.json': { k1: { source: 's1' } } }, php: {} }));
      return file;
    });
    for (const [name, content] of Object.entries(existing)) fs.writeFileSync(path.join(results, name), content);
    const messageFile = path.join(dir, 'last-message');
    if (message !== undefined) fs.writeFileSync(messageFile, message);
    const run = spawnSync(process.execPath, [script, messageFile, results, ...packetPaths], { encoding: 'utf8' });
    const written = Object.fromEntries(fs.readdirSync(results).map(f => [f, fs.readFileSync(path.join(results, f), 'utf8')]));
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, written };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const frCA = { locale: 'fr_CA', js: { 'monorepo/core.json': { 'reports.n_stores_many': '{n} magasins' } }, php: {} };

// 1. Missing results file, valid object on the final line.
let r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: 'Done. Results:\n' + JSON.stringify(frCA) });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(Object.keys(r.written), ['fr_CA.json']);
assert.deepEqual(JSON.parse(r.written['fr_CA.json']), frCA);
assert.equal(r.written['fr_CA.json'], JSON.stringify(frCA) + '\n');
assert.equal(r.stdout, "recovered fr_CA from the translator's last message\n");

// 2. Results file already exists: unchanged byte for byte, nothing printed.
const existing = '{ "locale": "fr_CA",  "js": {} }\n\n';
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: JSON.stringify(frCA), existing: { 'fr_CA.json': existing } });
assert.equal(r.status, 0, r.stderr);
assert.equal(r.written['fr_CA.json'], existing);
assert.equal(r.stdout, '');

// 3. Only a work-packet-shaped object for the locale: nothing written.
const packet = { locale: 'fr_CA', counts: { js: 1, php: 0 }, js: { 'monorepo/core.json': { 'reports.n_stores_many': { source: '{n} stores', plural_category: 'many', concepts: [] } } }, php: { core: { entries: [] } } };
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: 'Packet was:\n' + JSON.stringify(packet, null, 2) });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(r.written, {});
assert.equal(r.stdout, '');
const jsOnlyPacket = { locale: 'fr_CA', js: { 'monorepo/core.json': { k1: { source: 's1' } } } };
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: JSON.stringify(jsOnlyPacket) });
assert.deepEqual(r.written, {});

// 4. Results object for a different locale: nothing written.
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: JSON.stringify({ ...frCA, locale: 'fr' }) });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(r.written, {});
assert.equal(r.stdout, '');

// 5. Prose, a ```json fence and the same object twice (the way Codex logs it): one file, one line.
const twice = 'I wrote the translations.\n```json\n' + JSON.stringify(frCA, null, 2) + '\n```\ncodex\n' + JSON.stringify(frCA) + '\ntokens used: 1,234\n';
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: twice });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(Object.keys(r.written), ['fr_CA.json']);
assert.deepEqual(JSON.parse(r.written['fr_CA.json']), frCA);
assert.equal(r.stdout.split('\n').filter(line => RECOVERED.test(line)).length, 1);
assert.equal(r.stdout.trim().split('\n').length, 1);

// 6. Braces and escaped quotes inside strings round-trip exactly.
const tricky = { locale: 'fr_CA', js: { 'app/x.json': { a: '{n} magasins', b: 'a } b', c: 'say "{x}"', d: 'back\\slash {' } }, php: { id: ['un {n}', 'des } {n}'] } };
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' }, message: 'Here { is a stray brace.\n' + JSON.stringify(tricky) + '\n} and another' });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(JSON.parse(r.written['fr_CA.json']), tricky);
assert.ok(r.written['fr_CA.json'].includes('"say \\"{x}\\""'));

// 7. Two missing parts of the same locale: ambiguous, neither written.
const aa = { locale: 'aa', js: { 'app/x.json': { k1: 'translated k1' } } };
r = recover({ packets: { '.translate/parts/aa.part1.json': 'aa', '.translate/parts/aa.part2.json': 'aa' }, message: JSON.stringify(aa) });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(r.written, {});
assert.equal(r.stdout, '');

// 8. Message file does not exist: exit 0, nothing written.
r = recover({ packets: { '.translate/work/fr_CA.json': 'fr_CA' } });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(r.written, {});
assert.equal(r.stdout, '');

// 9. A part packet: written under the part name with the bare locale.
r = recover({ packets: { '.translate/parts/aa.part1.json': 'aa' }, message: JSON.stringify(aa) });
assert.equal(r.status, 0, r.stderr);
assert.deepEqual(Object.keys(r.written), ['aa.part1.json']);
assert.equal(JSON.parse(r.written['aa.part1.json']).locale, 'aa');
assert.equal(r.stdout, "recovered aa.part1 from the translator's last message\n");

// Wrong usage exits 2 with a usage line.
const usage = spawnSync(process.execPath, [script, 'only-one'], { encoding: 'utf8' });
assert.equal(usage.status, 2);
assert.match(usage.stderr, /^usage: /);

console.log('recover-results checks passed');
