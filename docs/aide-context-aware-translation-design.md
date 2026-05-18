# Context-Aware Aide Translation Design

## Summary

Aide should not translate isolated strings. Translation quality failures like Danish `Tendered` → `Tenderet` happen when a short ambiguous English UI label is translated without enough product, source-code, receipt/payment, and existing-translation context.

This design changes the translation pipeline from:

```text
msgid + broad global instructions → translated string
```

to:

```text
msgid + translator comments + source references + nearby strings + related translations + POS concept glossary → candidate translation → targeted context-aware review → committed translation
```

The goal is to prevent the entire class of literal, false-friend, and context-starved translations across all locales without adding locale-specific bandaid rules.

## Explicit Architecture Decision

**Decision:** build translation context packets in this repository and forward them to Aide as generated artifacts or payload references.

Reasons:

- The translations repo already has the POT/JSON source files, existing locale translations, `scripts/translation-context.md`, tests, and CI.
- The cheapest immediate wins are local and mechanical: preserve POT translator comments/references and attach related existing translations.
- This avoids making OpenClaw/Aide responsible for understanding every file format and repo convention before we can improve quality.
- Aide can remain the translator/reviewer, while this repo becomes the deterministic context provider.

Aide-side source lookup can still be added later, but it should not block Phase 1–3.

## Problem Statement

A user reported the Danish translation:

```po
msgid "Tendered"
msgstr "Tenderet"
```

This is not natural Danish in the WCPOS receipt/payment context. The intended meaning is money received from the customer, so the reported expected translation is `Modtaget`.

Git history shows the bad translation was introduced by an automated translation batch:

- Commit: `ddb1324fb234d2c304cccaf083d11507bbdbab8f`
- Date: 2026-04-11
- Author: `wcpos-bot[bot]`
- Message: `chore(i18n): update PHP translations for woocommerce-pos (49 locales, 8486 new)`

The root issue is not Danish specifically. The source string was a short standalone label:

```po
msgid "Tendered"
```

Without local context, the model chose a literal false cognate instead of the POS/payment meaning. The same failure mode can occur in any locale whenever English source strings are short, overloaded, or domain-specific.

## Goals

- Give Aide every available piece of context needed to produce natural target-locale translations.
- Prevent context-starved translations for short ambiguous labels.
- Use scalable product/domain context, not per-locale exception rules.
- Preserve existing structural QA: placeholders, plural forms, valid PO/JSON, completeness.
- Add targeted context-aware review for high-risk entries before translations are written or committed.
- Make improved translator comments/references trigger re-review of existing translations.

## Non-Goals

- Do not add Danish-specific rules such as `Tenderet` bans.
- Do not build a full human translation management system.
- Do not require native human review for every automated string before Aide can operate.
- Do not expand short POS UI labels into verbose explanations in the final translation.
- Do not require cross-repo source extraction changes before improving PHP translation quality.

## Current Pipeline Observations

The repo currently contains broad translation guidance in:

- `scripts/translation-context.md`

The legacy local PHP translation path in `scripts/translate-locale.js` sends batches shaped primarily around:

```json
{
  "msgid": "Tendered"
}
```

with optional plural/context fields when present. It does **not** pass through POT translator comments or references even though the POT already contains them.

For the reported string, the POT contains useful context:

```po
#. translators: Label for a receipt data field in the template editor.
#. translators: Standalone label used in printed receipt templates.
#: includes/Services/Receipt_Data_Schema.php:853
#: includes/Services/Receipt_I18n_Labels.php:169
#: templates/receipt.php:360
msgid "Tendered"
msgstr ""
```

Current automated checks focus mostly on structural correctness and known recurring heuristics:

- valid JSON/PO/PHP generated files
- completeness
- placeholders
- technical terms
- product naming
- known broad quality smoke checks

These checks do not reliably evaluate whether a one-word translation matches the intended source-code usage.

## Proposed Architecture

### 1. Translation Context Packet

Before sending a string to Aide, build a structured context packet. The packet is the canonical input for translation and review.

Minimum viable PHP packet:

```json
{
  "project": "woocommerce-pos",
  "domain": "woocommerce-pos",
  "format": "php-po",
  "locale": "da",
  "entry": {
    "msgid": "Tendered",
    "msgctxt": null,
    "msgid_plural": null,
    "translator_comments": [
      "Label for a receipt data field in the template editor.",
      "Standalone label used in printed receipt templates."
    ],
    "references": [
      "includes/Services/Receipt_Data_Schema.php:853",
      "includes/Services/Receipt_I18n_Labels.php:169",
      "templates/receipt.php:360"
    ]
  },
  "source_usage": {
    "areas": ["receipt", "payment", "template editor"],
    "nearby_source_strings": [
      "Payment Method",
      "Amount",
      "Tendered",
      "Change",
      "Transaction ID"
    ]
  },
  "related_existing_translations": [
    {
      "msgid": "Amount Tendered",
      "msgstr": "Indbetalt beløb"
    },
    {
      "msgid": "Tendered amount must be zero or greater.",
      "msgstr": "Modtaget beløb skal være nul eller højere."
    },
    {
      "msgid": "Change",
      "msgstr": "Byttepenge"
    }
  ],
  "concept_hints": [
    {
      "id": "amount_tendered",
      "meaning": "Money received from the customer during checkout; printed on receipts and shown in payment UI.",
      "avoid_meanings": [
        "procurement tender",
        "bid",
        "public contract offer"
      ],
      "style": "Short natural POS receipt label for the target locale."
    }
  ],
  "risk": {
    "level": "high",
    "reasons": [
      "short standalone label",
      "concept glossary match",
      "receipt/payment source references"
    ]
  }
}
```

### 2. Phase-1 Context Should Use Existing POT Data First

The first implementation should not depend on cross-repo source snippets.

Use what is already present in this repo:

- `msgid`
- `msgctxt`
- `msgid_plural`
- `entry.comments.translator`
- `entry.comments.reference`
- neighboring POT entries
- existing same-locale translations
- `scripts/translation-context.md`
- concept glossary matches

This is enough to materially improve the reported failure mode.

### 3. Source Reference and Snippet Retrieval

Source snippets are useful but should be Phase 4, not Phase 1.

The receive workflow currently deletes temporary source branches after Aide is invoked. Requiring durable source SHAs would require coordinated changes across producer repos. Therefore, source snippets should be added only after the local context packet proves valuable.

Preferred snippet strategy when implemented:

1. Snapshot snippets during receive, while the source branch is still checked out.
2. Store snippets in the generated context artifact.
3. Forward the artifact to Aide.
4. Then delete the source branch.

This avoids cross-repo coordination and makes context reproducible.

Suggested usage area hints can be driven by repo-local config, not hardcoded scattered logic:

```json
{
  "php_reference_area_patterns": [
    { "pattern": "templates/receipt.php", "areas": ["receipt"] },
    { "pattern": "Receipt_", "areas": ["receipt"] },
    { "pattern": "Gateways/", "areas": ["payment"] },
    { "pattern": "Cash.php", "areas": ["cash payment"] },
    { "pattern": "Templates/", "areas": ["template editor"] },
    { "pattern": "Settings", "areas": ["settings"] },
    { "pattern": "Admin|wp-admin", "areas": ["admin"] }
  ]
}
```

### 4. Related Translation Lookup

For each string, include nearby and semantically related existing translations from the same locale.

Sources of related translations:

- exact shared normalized tokens, e.g. `Tendered`, `Amount Tendered`, `Tendered amount`
- same source references or nearby reference paths
- neighboring POT/JSON entries
- same `msgctxt`
- same JSON namespace or key prefix
- same concept glossary match

The goal is consistency. In the reported issue, Aide should have seen that Danish already translated `Tendered amount` as `Modtaget beløb`, making literal `Tenderet` suspicious.

Matching should be conservative to avoid noisy packets:

- exact `msgid` match wins
- exact phrase containment wins for multi-word phrases
- for one-word labels, match only against entries that contain the same token as a full word
- cap related translations, e.g. top 5–10 entries ranked by reference proximity, token overlap, and concept match

### 5. Product Concept Glossary

Create a product/domain glossary organized by English product concepts, not by target-locale outputs.

Proposed file:

```text
scripts/translation-concepts.json
```

Example concept:

```json
{
  "id": "amount_tendered",
  "source_terms": [
    "Tendered",
    "Amount Tendered",
    "Tendered amount"
  ],
  "meaning": "Money received from the customer during checkout. Usually displayed in payment UI, receipt data, and printed receipt templates.",
  "avoid_meanings": [
    "procurement tender",
    "bid",
    "offer for a public contract"
  ],
  "style": "Use the concise, natural retail/payment term for the target locale."
}
```

The glossary should be additive to `scripts/translation-context.md`, not a competing replacement:

- `translation-context.md` remains the human-readable global instructions.
- `translation-concepts.json` is the machine-readable concept index used for matching and context packets.
- Shared content should be generated or reviewed together to prevent drift.

#### Glossary Matcher Spec

Initial matcher behavior:

- Normalize Unicode and whitespace.
- Compare case-insensitively for Latin-script source terms.
- Match exact full source string first.
- Match full-word source terms only, not arbitrary substrings.
- For multi-word terms, allow singular punctuation/spacing differences but not reordered words.
- If multiple concepts match, include all, capped by priority/order in the glossary file.

Ownership:

- Translation issue investigations should update the glossary when the mistake reveals a reusable product concept.
- Glossary PRs should explain the reported issue or source ambiguity that motivated the concept.
- No locale-specific expected translations should be added to this glossary.

Initial concepts should cover recurring POS ambiguity:

- `amount_tendered`
- `tender_payment_method`
- `change_due`
- `register`
- `drawer`
- `void`
- `split_payment`
- `refund`
- `receipt`
- `order`
- `rate`
- `tax_rate`
- `shipping_rate`
- `state_region`
- `key_identifier_vs_keyboard_key`

### 6. Targeted Two-Stage Aide Workflow

A full two-stage review for every string is too expensive. Use targeted review first.

#### Stage A: Candidate Translation

Given the context packet, Aide returns candidate translations.

#### Stage B: Context-Aware Review for High-Risk Entries

Run review only for entries marked high-risk or changed entries with concept matches.

Review questions:

- Does the translation fit the source references and translator comments?
- Does it align with nearby receipt/payment/admin labels?
- Is it consistent with related existing translations?
- Does it avoid wrong meanings listed by concept hints?
- Is it natural target-locale UI text?
- Is it concise enough for POS UI?
- Are placeholders, tags, and technical terms preserved?

If review fails, Aide revises once using the review findings. If it still fails, the pipeline should surface the entry for review rather than silently committing a questionable translation.

### 7. Ambiguity Detection

Mark an entry as high-risk when it matches one or more patterns:

- source has 1–2 words
- source is Title Case or a standalone label
- source has no sentence punctuation
- source term appears in the concept glossary
- source appears in receipt/payment/tax/settings/schema paths
- source shares tokens with longer existing strings
- source has different meanings in general English and POS English

High-risk entries receive the richest available context and mandatory targeted review.

### 8. Context-Aware Freshness Hashing

Existing translations should be re-reviewed when meaningful context changes.

For PHP entries, calculate freshness from:

- `msgid`
- `msgctxt`
- `msgid_plural`
- extracted translator comments
- source references
- concept glossary match IDs/version
- nearby source string group hash, where feasible

For JS entries, include:

- source key
- source string
- namespace/file path
- explicit source context, if present
- nearby namespace/key siblings
- concept glossary match IDs/version

This prevents stale translations from surviving after comments/references improve.

### 9. Back-Translation QA Relationship

`scripts/qa-translations.js` already performs semantic back-translation review in the legacy local path. The new context-aware review should not duplicate it blindly.

Recommended positioning:

- Structural QA remains mandatory for all changed translations.
- Existing back-translation QA remains available for broad semantic spot checks.
- Context-aware review becomes the targeted semantic check for high-risk/context-rich entries.
- Over time, context-aware review can replace generic back-translation for high-risk entries if it proves more precise.

### 10. Human Review Landing Zone

There is no dedicated review queue today. Do not invent one in the first implementation.

Initial behavior:

- Warn in PR/CI summaries for uncertain or failed high-risk reviews.
- Include file, locale, source string, candidate translation, review reason, and context summary.
- Do not silently commit low-confidence changes without a visible warning.

Deployment policy:

1. First 4 weeks: warning-only for all context-aware review warnings.
2. After review of false positive/false negative rate: block PRs only for high-risk entries where review says the translation likely contradicts the source context.
3. Keep low-confidence but non-contradictory cases warning-only unless human review capacity exists.

## JS Pipeline Limitations

PHP is much better positioned because POT files include translator comments and file:line references.

Current JS source is flat JSON such as:

```text
source/js/monorepo/core.json
```

with strings keyed by namespace/key. The source extraction path currently does not preserve origin file paths or source-code comments in this repo. Therefore:

- JS Phase 1 should use namespace/file path, key names, nearby JSON siblings, related translations, and concept glossary matches.
- JS source snippets require upstream extraction changes in producer repos.
- JS source-origin preservation should be treated as a separate upstream enhancement, not a blocker for PHP context improvements.

## Cost and Latency Strategy

A two-stage review for every string is too expensive at translation-batch scale.

Cost controls:

- Only run context-aware review for high-risk entries initially.
- Batch low-risk translations with context but no second review call.
- Use deterministic local heuristics for risk detection before invoking review.
- Cap related translations and snippet size.
- Consider a cheaper/faster model for Stage B after quality evaluation.
- Add per-run counters: total strings, high-risk strings, reviewed strings, warnings, failed reviews.
- Add a configurable review budget cap with clear reporting when exceeded.

Expected rollout should measure the high-risk percentage before enforcing review broadly.

## Data Flow

```text
Source repo extracts POT/JSON
        ↓
translations repo receives source files
        ↓
context packet builder parses source entries
        ↓
translator comments/references, nearby strings, related translations, and glossary concepts attached
        ↓
Aide translates with context packet
        ↓
Aide reviews high-risk candidates against packet
        ↓
passed translations written to PO/JSON; uncertain entries warned
        ↓
structural QA + context-aware QA summary run
        ↓
PR/release proceeds or warnings request review
```

## Workflow Changes

### Forward to Aide

The payload should evolve from project/files only to include generated context artifacts.

Current shape:

```json
{
  "project": "woocommerce-pos",
  "changed_files": ["source/php/woocommerce-pos.pot"]
}
```

Proposed shape:

```json
{
  "project": "woocommerce-pos",
  "type": "php",
  "changed_files": ["source/php/woocommerce-pos.pot"],
  "context_artifacts": [
    "translation-context/php/woocommerce-pos.context.json"
  ]
}
```

The context artifact is generated in this repo before invoking Aide. If artifact upload is not convenient, the same JSON can be committed to a temporary branch or included directly when size permits.

## Implementation Phases

### Phase 0: Verify Current Aide Contract

Decide and document exactly what Aide receives and reads today.

Tasks:

- Inspect `forward-to-aide.yml` payload generation.
- Inspect Aide/OpenClaw webhook consumer, if available.
- Confirm whether Aide reads only `project`/`changed_files` or fetches additional repo context.
- Record the confirmed contract in this design or implementation PR.

Verification command in this repo:

```bash
sed -n '70,100p' .github/workflows/forward-to-aide.yml
```

Confirmed on 2026-05-18 in this repository: before this implementation, `.github/workflows/forward-to-aide.yml` built the webhook payload with only `project` and `changed_files`:

```json
{
  "project": "woocommerce-pos",
  "changed_files": ["source/php/woocommerce-pos.pot"]
}
```

The implementation changes the payload shape to include `type` and generated `context_artifacts` while preserving the original fields for backwards compatibility.

### Phase 1: Plumb Translator Comments and References

Mechanical first win.

Tasks:

- Update context packet generation to extract `entry.comments.translator` and `entry.comments.reference` from POT entries.
- Ensure Aide receives those fields.
- Add a fixture test proving `Tendered` carries receipt/template comments and references.

Acceptance test fixture should assert that the packet for `Tendered` contains:

- `Label for a receipt data field in the template editor.`
- `Standalone label used in printed receipt templates.`
- `includes/Services/Receipt_Data_Schema.php:853`
- `includes/Services/Receipt_I18n_Labels.php:169`
- `templates/receipt.php:360`

### Phase 2: Related Translation Lookup

Highest leverage for the reported issue.

Tasks:

- Add related-translation lookup for same-locale existing translations.
- Rank by exact/phrase/token match and reference proximity.
- Cap output to avoid noisy packets.
- Add fixture test proving `Tendered` context includes related Danish entries for `Amount Tendered` and `Tendered amount must be zero or greater.`

### Phase 3: Concept Glossary and Matcher

Tasks:

- Create `scripts/translation-concepts.json`.
- Add matcher with the behavior specified above.
- Add fixture tests for reusable ambiguity cases: `Tendered`, `No`, `Key`, `State`, `Tender`, `Void`, `Rate`.
- Ensure tests verify concept hints, not locale-specific target translations.

### Phase 4: Source Snippets

Only implement if Phases 1–3 do not close enough of the gap.

Tasks:

- Snapshot snippets during receive while source branch exists.
- Add snippets to context artifacts.
- Keep snippet size small, e.g. ±8–12 lines.
- Avoid durable SHA dependency unless producer repos already provide it.

### Phase 5: Targeted Context-Aware Review

Tasks:

- Add high-risk detection.
- Run Stage B review only for high-risk/context-rich entries.
- Report review status in CI/PR summaries.
- Keep warning-only initially.

### Phase 6: Context-Aware Freshness Hashing

Tasks:

- Include comments/references/concept IDs in freshness state.
- Add tests showing a changed translator comment invalidates the previous context hash.
- Re-review stale high-risk strings when context changes.

### Phase 7: CI Summary and Deployment Policy

Tasks:

- Emit counters for total/high-risk/reviewed/warned entries.
- Add PR summary output for warnings.
- Run warning-only for 4 weeks.
- After measurement, decide whether to block high-risk contradictions.

## Acceptance Criteria

- Context packet generation runs in this repository.
- Aide receives translator comments for PHP PO entries.
- Aide receives source references for PHP PO entries.
- Aide receives nearby strings and related existing translations.
- Aide receives product concept hints for ambiguous POS terms.
- Glossary matching is tested and is not locale-specific.
- High-risk short labels receive targeted context-aware review.
- Translation freshness changes when meaningful comments/references/concept matches change.
- JS limitations are documented and do not block PHP improvements.
- No locale-specific special-case rule is added for Danish `Tendered`.
- The reported class of issue is addressed by scalable semantic context and review.

## Example: How This Prevents the Reported Issue

Instead of seeing only:

```json
{
  "msgid": "Tendered"
}
```

Aide sees:

- receipt/template editor comments
- references to receipt/payment source files
- nearby strings: `Payment Method`, `Amount`, `Change`
- related Danish translations: `Tendered amount` → `Modtaget beløb`
- concept hint: money received from customer; avoid procurement/bid meaning

A context-aware review would flag a literal/procurement-style translation as inconsistent with the receipt/payment concept before writing it.

## Open Questions

- Should context artifacts be uploaded as workflow artifacts, committed temporarily, or passed inline when small enough?
- What exact Aide/OpenClaw API changes are needed to consume context artifacts?
- What high-risk percentage do real translation batches produce?
- What review model gives the best cost/quality tradeoff for Stage B?
- After the 4-week warning-only period, what threshold justifies blocking high-risk contradictions?
- Should human-reviewed corrections feed back into the concept glossary or a separate translation memory?
