# WCPOS Translations

AI-powered translation management for WCPOS apps and plugins.

## Structure

- `source/js/` — Extracted English strings from JS monorepo (grouped by tag)
- `source/php/` — Extracted .pot files from WordPress plugins
- `translations/js/{locale}/` — Translated JS strings (JSON)
- `translations/php/{locale}/` — Translated PHP strings (.po, .mo, .l10n.php)
- `scripts/` — Extraction, translation, QA, and generation scripts

## Automated Pipeline

Source repos push strings to this repo via `repository_dispatch`. From there:

1. **Receive** (GitHub Actions): source strings are committed to main.
2. **Translate** (local, scheduled): `scripts/translate-local.sh` runs on the Mac mini, fills every missing string, and opens or updates one PR labelled `auto-translate`. See [Translation pipeline](#translation-pipeline).
3. **Review**: a human reviews and merges the PR.
4. **Release**: a release is auto-created on merge using CalVer (`YYYY.M.N`).
5. **Update consumers**: this repo opens or updates version-bump PRs in consuming repos.

GitHub Actions hold no model API keys. They only run the deterministic steps: string intake, completeness reporting, quality smoke checks and releases.

## Versioning

Releases use **CalVer** format: `YYYY.M.N` (e.g., `2026.2.0`, `2026.2.1`).

- `YYYY` — Year
- `M` — Month (no leading zero, semver-compatible)
- `N` — Sequential release number within the month (starts at 0)

Versions are decoupled from plugin/app versions. Each consumer pins the translation version it was built against.

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| Receive JS Strings | `repository_dispatch` | Commit JS source strings |
| Receive PHP Strings | `repository_dispatch` | Commit PHP POT files |
| Check Translation Completeness | Daily 08:00 UTC or manual | Open a `translation-gaps` issue when strings are missing |
| Translation Quality Smoke Check | PRs touching translations | Heuristic quality warnings |
| Release | Auto on merge or manual | CalVer tag + GitHub Release + update/reuse consumer PRs |

## JS Distribution (jsDelivr)

```
https://cdn.jsdelivr.net/gh/wcpos/translations@{version}/translations/js/{locale}/{project}/{namespace}.json
```

Example:
```
https://cdn.jsdelivr.net/gh/wcpos/translations@2026.2.0/translations/js/de_DE/monorepo/core.json
```

## PHP Distribution

PHP translation files (.mo, .l10n.php) are attached to GitHub Releases and can be fetched by the plugin's translation updater.

## Consumer Integration

See [docs/CONSUMER-INTEGRATION.md](docs/CONSUMER-INTEGRATION.md) for instructions on receiving translation version updates in consuming repos.

## Translation Pipeline

Translation runs locally on Paul's Mac mini with Claude or Codex models on his subscriptions. It replaced the OpenClaw/Aide webhook, which was retired in September 2026.

```bash
scripts/translate-local.sh             # what the schedule runs
scripts/translate-local.sh --dry-run   # show per-locale work, no model call
scripts/translate-local.sh --locale de_DE --translator claude   # Claude Sonnet instead of Codex
```

Each run:

1. Syncs its own worktree (`.claude/worktrees/auto-translate`) with `origin/main`, or with the open `auto-translate` PR branch. The script updates itself from `origin/main`, and a lock prevents overlapping runs.
2. Runs `scripts/translation-worklist.js`, which writes one packet per locale with missing JS keys or untranslated PO entries (the same gaps `check-completeness.js` reports). **With no gaps it exits 0 without calling a model.**
3. Hands the packets to the translator CLI (default Codex `gpt-6-sol`) with `scripts/translate-prompt.md`. The model writes results JSON only.
4. Runs `scripts/apply-translations.js`, which checks every translation with `scripts/translation-rules.js` and writes the accepted ones to JSON, `.po` and `.l10n.php` files. Placeholders, markup and product names are checked as errors; the glossary and locale formatting are checked as warnings. Rejected strings stay missing and are retried on the next run.
5. Runs `validate-translations.js`, the quality smoke check and the completeness check, then commits, pushes and opens the PR (or comments on the open one).

Translation knowledge lives in:

- `scripts/translation-context.md`: the general quality contract
- `scripts/translation-glossary.json`: required per-locale terms
- `scripts/locale-context/<locale>.md`: per-locale register and pitfalls
- `scripts/locale-rules.json`: decimal separators and forbidden patterns
- `scripts/english-rules.json`: US-English checks on source strings
- `scripts/translation-concepts.json`: disambiguation for Tender, Change, Void, Key and similar words
- `.ai/rules/`: rules for humans and agents doing manual fixes

Product naming: use `WCPOS` and `WCPOS Pro` in customer-facing strings, never `WooCommerce POS` / `WooCommerce POS Pro`. The exceptions are technical identifiers such as slugs, filenames, repo names and URLs.

Useful commands:

```bash
# Human-readable release gate; exits 1 while release-blocking translation debt remains
node scripts/check-completeness.js

# Machine-readable triage; exits 0
pnpm --silent run check:completeness:json

# Heuristic quality smoke check for recent translation changes
pnpm run qa:quality -- --changed-since origin/main
```

## Local Development

```bash
pnpm install

# Extract source strings
pnpm run extract:js
pnpm run extract:php

# Fill missing translations (see Translation Pipeline)
scripts/translate-local.sh

# Generate .mo and .l10n.php
pnpm run generate:php
```

## License

The tooling, scripts, and configuration in this repository are licensed under [MIT](./LICENSE). The generated translation files under `translations/` and the extracted sources under `source/` are derived from their upstream WordPress plugins and retain those projects' original licenses (GPL-3.0-or-later for the WooCommerce POS PHP plugins). MIT applies to this repository's original tooling, not to the translated plugin strings.
