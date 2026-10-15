#!/usr/bin/env node

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

for (const [name, expected] of [
  ['receive-js-strings.yml', 1],
  ['receive-php-strings.yml', 2],
  ['release.yml', 1],
]) {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8');
  const steps = workflow.match(/      - name: [^\n]*\n(?:(?!      - name:)[\s\S])*/g) || [];
  const pushTokens = steps.filter(step => /^        id: push-token$/m.test(step));

  test(`${name} has ${expected} translations push token step(s)`, () => {
    assert.strictEqual(pushTokens.length, expected);
  });
  for (const [index, step] of pushTokens.entries()) {
    test(`${name} push token ${index + 1} can write translations`, () => {
      assert.match(step, /^          repositories: translations$/m);
      assert.match(step, /^          permission-contents: write$/m);
    });
  }

  if (name.startsWith('receive-')) {
    const commits = steps.filter(step => /^      - name: Commit(?: changes)?\n/.test(step));
    test(`${name} commit steps use translations push tokens`, () => {
      assert.strictEqual(commits.length, expected);
      for (const commit of commits) {
        assert.ok(!commit.includes('secrets.GITHUB_TOKEN'));
        assert.ok(commit.includes('steps.push-token.outputs.token'));
      }
    });
  } else {
    test(`${name} checkout uses the preceding translations push token`, () => {
      const checkout = steps.find(step => step.startsWith('      - name: Checkout\n'));
      assert.ok(checkout, 'Checkout step is missing');
      assert.ok(checkout.includes('token: ${{ steps.push-token.outputs.token }}'));
      assert.ok(pushTokens.length === 1 && steps.indexOf(pushTokens[0]) < steps.indexOf(checkout));
    });
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
