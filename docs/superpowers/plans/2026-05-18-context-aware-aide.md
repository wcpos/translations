# Context-Aware Aide Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic translation context artifacts in this repository so Aide receives POT translator comments, source references, nearby strings, related same-locale translations, and concept hints for ambiguous POS terms.

**Architecture:** Add a small context-packet builder module that parses POT/PO files with `gettext-parser` and emits one JSON artifact per source file/domain. The workflow generates these artifacts before calling Aide and adds artifact paths to the webhook payload while preserving the existing `project` and `changed_files` contract. Legacy local PHP translation can reuse the same packet builder to include richer entry context in prompts without duplicating parsing logic.

**Tech Stack:** Node.js CommonJS scripts, `gettext-parser`, existing no-framework Node tests, GitHub Actions shell/JQ workflow.

---

## File Structure

- Create `scripts/translation-context-packets.js`: pure helper module and CLI for building context artifacts. Responsibilities: parse PHP POT entries, collect comments/references, nearby strings, related existing translations, glossary concept matches, and risk metadata; write stable JSON artifacts.
- Create `scripts/translation-concepts.json`: machine-readable English concept glossary. It contains concept meanings and avoid-meanings only, never target-locale translations.
- Create `tests/test-translation-context-packets.js`: fixture-driven tests for comments/references, related Danish translations, concept matching, risk detection, and CLI artifact output.
- Modify `package.json`: add `generate:context` and include the new test in `test`/`test:all`.
- Modify `.github/workflows/forward-to-aide.yml`: generate context artifacts before webhook dispatch and include `type` plus `context_artifacts` in the payload.
- Modify `scripts/translate-locale.js`: use context packets for PHP prompt input and include comment/reference/context hash fields in PHP freshness hashes.
- Modify `docs/aide-context-aware-translation-design.md`: update Phase 0 with the confirmed current contract and mark Phase 1 implementation shape.

## Task 1: Context Packet Builder Foundation

**Files:**
- Create: `scripts/translation-context-packets.js`
- Create: `tests/test-translation-context-packets.js`
- Create: `scripts/translation-concepts.json`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for POT comments/references and concept matches**

Add this initial test file:

```js
#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {
  buildPhpContextPackets,
  matchConcepts,
  normalizeSourceTerm,
} = require('../scripts/translation-context-packets');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  ${error.message}`);
    failed++;
  }
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-context-'));
  fs.mkdirSync(path.join(dir, 'source/php'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'translations/php/da_DK'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'source/php/woocommerce-pos.pot'), `msgid ""
msgstr ""
"Project-Id-Version: WooCommerce POS\\n"

#. translators: Label for a receipt data field in the template editor.
#. translators: Standalone label used in printed receipt templates.
#: includes/Services/Receipt_Data_Schema.php:853
#: includes/Services/Receipt_I18n_Labels.php:169
#: templates/receipt.php:360
msgid "Tendered"
msgstr ""

#: includes/Services/Receipt_Data_Schema.php:852
msgid "Amount"
msgstr ""

#: includes/Services/Receipt_Data_Schema.php:854
msgid "Change"
msgstr ""

#: includes/Gateways/Cash.php:48
msgid "Amount Tendered"
msgstr ""

#: includes/Gateways/Cash.php:52
msgid "Tendered amount must be zero or greater."
msgstr ""
`);

  fs.writeFileSync(path.join(dir, 'translations/php/da_DK/woocommerce-pos-da_DK.po'), `msgid ""
msgstr ""
"Project-Id-Version: WooCommerce POS\\n"
"Language: da_DK\\n"

#: includes/Gateways/Cash.php:48
msgid "Amount Tendered"
msgstr "Indbetalt beløb"

#: includes/Gateways/Cash.php:52
msgid "Tendered amount must be zero or greater."
msgstr "Modtaget beløb skal være nul eller højere."
`);

  return dir;
}

test('normalizes source terms case-insensitively with stable whitespace', () => {
  assert.strictEqual(normalizeSourceTerm('  Tendered\nAmount  '), 'tendered amount');
});

test('matches glossary concepts by full source term, not arbitrary substring', () => {
  const tendered = matchConcepts('Tendered');
  assert.ok(tendered.some(concept => concept.id === 'amount_tendered'));

  const contender = matchConcepts('Contender');
  assert.ok(!contender.some(concept => concept.id === 'amount_tendered'));
});

test('builds PHP context packet with translator comments and source references', () => {
  const root = makeTempRepo();
  const packets = buildPhpContextPackets({ rootDir: root, locale: 'da_DK', domain: 'woocommerce-pos' });
  const tendered = packets.entries.find(packet => packet.entry.msgid === 'Tendered');

  assert.ok(tendered, 'expected Tendered packet');
  assert.deepStrictEqual(tendered.entry.translator_comments, [
    'Label for a receipt data field in the template editor.',
    'Standalone label used in printed receipt templates.',
  ]);
  assert.deepStrictEqual(tendered.entry.references, [
    'includes/Services/Receipt_Data_Schema.php:853',
    'includes/Services/Receipt_I18n_Labels.php:169',
    'templates/receipt.php:360',
  ]);
  assert.ok(tendered.source_usage.nearby_source_strings.includes('Amount'));
  assert.ok(tendered.source_usage.nearby_source_strings.includes('Change'));
});

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, ${failed} failed`);
```

- [ ] **Step 2: Run the new test and verify it fails because the module does not exist**

Run:

```bash
node tests/test-translation-context-packets.js
```

Expected: FAIL with `Cannot find module '../scripts/translation-context-packets'`.

- [ ] **Step 3: Add the concept glossary**

Create `scripts/translation-concepts.json`:

```json
[
  {
    "id": "amount_tendered",
    "source_terms": ["Tendered", "Amount Tendered", "Tendered amount"],
    "meaning": "Money received from the customer during checkout. Usually displayed in payment UI, receipt data, and printed receipt templates.",
    "avoid_meanings": ["procurement tender", "bid", "offer for a public contract"],
    "style": "Use the concise, natural retail/payment term for the target locale."
  },
  {
    "id": "tender_payment_method",
    "source_terms": ["Tender", "Tender type", "Tender method"],
    "meaning": "Payment method or payment tender used to complete a POS sale.",
    "avoid_meanings": ["public procurement process", "soft or gentle"],
    "style": "Use concise payment terminology."
  },
  {
    "id": "change_due",
    "source_terms": ["Change", "Change due"],
    "meaning": "Cash owed back to the customer after the amount tendered exceeds the order total.",
    "avoid_meanings": ["modify", "alter", "general difference"],
    "style": "Use the natural retail cash-register term."
  },
  {
    "id": "key_identifier_vs_keyboard_key",
    "source_terms": ["Key", "Keys", "API key", "License key"],
    "meaning": "Identifier, credential, or keyboard key depending on the source context.",
    "avoid_meanings": ["physical door key unless source context clearly says lock or door"],
    "style": "Use the source comments, key name, and references to choose credential versus keyboard meaning."
  },
  {
    "id": "state_region",
    "source_terms": ["State", "State / County", "State/County"],
    "meaning": "Geographic administrative region in an address, tax, or shipping context.",
    "avoid_meanings": ["condition", "status", "government state unless address context requires it"],
    "style": "Use the target locale's address-region convention."
  },
  {
    "id": "void",
    "source_terms": ["Void", "Void order", "Voided"],
    "meaning": "Cancel or invalidate a POS order, line item, or transaction.",
    "avoid_meanings": ["empty space", "null value"],
    "style": "Use concise POS transaction terminology."
  },
  {
    "id": "rate",
    "source_terms": ["Rate"],
    "meaning": "Percentage or charged amount depending on tax or shipping context.",
    "avoid_meanings": ["rating/review score unless review context is explicit"],
    "style": "Use source references to distinguish tax rate, shipping rate, and rating."
  }
]
```

- [ ] **Step 4: Implement minimal builder exports**

Create `scripts/translation-context-packets.js` with `normalizeSourceTerm`, `matchConcepts`, `buildPhpContextPackets`, and CommonJS exports. Use `gettext-parser.po.parse`, read `source/php/<domain>.pot`, split translator comments from `entry.comments.translator`, split references from `entry.comments.reference`, and compute nearby strings from adjacent POT entries.

- [ ] **Step 5: Run the new test and verify it passes**

Run:

```bash
node tests/test-translation-context-packets.js
```

Expected: PASS for the first four tests.

- [ ] **Step 6: Wire the test into package scripts**

Update `package.json` so both `test` and `test:all` include:

```bash
node tests/test-translation-context-packets.js
```

- [ ] **Step 7: Run full tests**

Run:

```bash
npm test
```

Expected: all existing tests plus `test-translation-context-packets.js` pass.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add scripts/translation-context-packets.js scripts/translation-concepts.json tests/test-translation-context-packets.js package.json
git commit -m "feat: build translation context packets"
```

## Task 2: Related Translation Lookup and CLI Artifact Output

**Files:**
- Modify: `scripts/translation-context-packets.js`
- Modify: `tests/test-translation-context-packets.js`
- Modify: `package.json`

- [ ] **Step 1: Add failing tests for related Danish translations and CLI output**

Append tests asserting that the `Tendered` packet includes related translations for `Amount Tendered` and `Tendered amount must be zero or greater.`, caps related translations to 10, marks risk as high, and writes `translation-context/php/woocommerce-pos.context.json` from the CLI.

- [ ] **Step 2: Run the tests and verify related/CLI assertions fail**

Run:

```bash
node tests/test-translation-context-packets.js
```

Expected: FAIL because related lookup and CLI writing are incomplete.

- [ ] **Step 3: Implement related translation ranking**

In `scripts/translation-context-packets.js`, load `translations/php/<locale>/<domain>-<locale>.po`, build same-locale translation entries, rank by exact source match, phrase containment, full-word token overlap, reference path proximity, and concept overlap. Cap at 10.

- [ ] **Step 4: Implement CLI output**

Support:

```bash
node scripts/translation-context-packets.js --type php --locale da_DK --domain woocommerce-pos --out-dir translation-context/php
```

Write stable formatted JSON to `translation-context/php/woocommerce-pos.context.json` and print the path.

- [ ] **Step 5: Add package script**

Add:

```json
"generate:context": "node scripts/translation-context-packets.js"
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node tests/test-translation-context-packets.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add scripts/translation-context-packets.js tests/test-translation-context-packets.js package.json
git commit -m "feat: add related translation context artifacts"
```

## Task 3: Forward Context Artifacts to Aide

**Files:**
- Modify: `.github/workflows/forward-to-aide.yml`
- Modify: `tests/test-workflow.js`
- Modify: `docs/aide-context-aware-translation-design.md`

- [ ] **Step 1: Add failing workflow tests**

Update `tests/test-workflow.js` to assert `forward-to-aide.yml` invokes `scripts/translation-context-packets.js`, builds a `context_artifacts` JSON array, and includes `type` plus `context_artifacts` in the webhook payload.

- [ ] **Step 2: Run workflow tests and verify failure**

Run:

```bash
node tests/test-workflow.js
```

Expected: FAIL because the workflow still sends only `project` and `changed_files`.

- [ ] **Step 3: Update the workflow**

In `.github/workflows/forward-to-aide.yml`, before `payload=$(jq -n ...)`, generate PHP context artifacts when `type=php` with:

```bash
mkdir -p translation-context/php
context_artifacts='[]'
if [ "$type" = "php" ]; then
  while IFS= read -r file; do
    domain=$(basename "$file" .pot)
    while IFS= read -r locale; do
      locale_out_dir="translation-context/php/${locale}"
      mkdir -p "$locale_out_dir"
      artifact=$(node scripts/translation-context-packets.js --type php --locale "$locale" --domain "$domain" --out-dir "$locale_out_dir")
      context_artifacts=$(jq -c --arg artifact "$artifact" '. + [$artifact]' <<< "$context_artifacts")
    done < <(find translations/php -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
  done < <(echo "$changed_files" | jq -r '.[]')
fi
```

Then include `--arg type "$type" --argjson context_artifacts "$context_artifacts"` and payload fields `{project, type, changed_files, context_artifacts}`.

- [ ] **Step 4: Update design doc Phase 0**

Record that on 2026-05-18 the current workflow payload was verified from `.github/workflows/forward-to-aide.yml` and contained only `project`/`changed_files` before this implementation.

- [ ] **Step 5: Run workflow tests and full tests**

Run:

```bash
node tests/test-workflow.js
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add .github/workflows/forward-to-aide.yml tests/test-workflow.js docs/aide-context-aware-translation-design.md
git commit -m "feat: forward translation context artifacts to Aide"
```

## Task 4: Legacy PHP Translation Prompt and Freshness Hash Reuse

**Files:**
- Modify: `scripts/translate-locale.js`
- Modify: `tests/test-translation.js`

- [ ] **Step 1: Add failing tests for PHP context prompt shape and freshness hash**

Export a small pure helper from `scripts/translate-locale.js`, for example `buildPhpTranslationInput(entryPacket)` and `hashPhpEntryContext(entryPacket)`, guarded so `main()` only runs when `require.main === module`. Test that translator comments, references, related translations, and concept IDs are present in the prompt input and that changing a translator comment changes the hash.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node tests/test-translation.js --dry-run
```

Expected: FAIL because helper exports do not exist.

- [ ] **Step 3: Refactor `translate-locale.js` safely**

Add `if (require.main === module) main().catch(...)` and export the helper functions. Do not change runtime behavior yet.

- [ ] **Step 4: Use packets in PHP translation**

In `translatePhpFile`, build packets once for `domain`/`locale`, look up each entry by context+msgid, use packet-derived input in the Aide/OpenAI prompt, and compute hashes from `msgid`, `msgctxt`, `msgid_plural`, translator comments, references, and concept IDs.

- [ ] **Step 5: Run targeted and full tests**

Run:

```bash
node tests/test-translation.js --dry-run
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add scripts/translate-locale.js tests/test-translation.js
git commit -m "feat: use context packets in PHP translation prompts"
```

## Task 5: Final Verification and PR

**Files:**
- No planned source edits unless verification finds a defect.

- [ ] **Step 1: Run full validation**

Run:

```bash
npm test
npm run test:all
```

Expected: both commands complete successfully. Existing warnings from extraction fixtures are acceptable because current baseline emits them while passing.

- [ ] **Step 2: Check branch state before push**

Run:

```bash
git status --short
git branch -vv | grep $(git branch --show-current)
gh pr list --head $(git branch --show-current)
gh pr list --head $(git branch --show-current) --state merged
```

Expected: clean status, no merged/deleted upstream conflict.

- [ ] **Step 3: Push and open PR**

Run:

```bash
git push -u origin feat/context-aware-aide
```

Open a PR summarizing context packet generation, Aide payload changes, tests, and validation output.

## Self-Review

- Spec coverage: Phase 0 is covered by Task 3 doc/workflow verification. Phase 1 is covered by Task 1 and Task 4. Phase 2 is covered by Task 2. Phase 3 starts with glossary/matcher coverage in Task 1. Later targeted two-stage review, snippets, freshness enforcement beyond local translation, and CI summaries remain future phases.
- Placeholder scan: no TBD/TODO placeholders remain in implementation steps.
- Type consistency: shared packet fields are consistently named `translator_comments`, `references`, `nearby_source_strings`, `related_existing_translations`, `concept_hints`, and `risk`.
