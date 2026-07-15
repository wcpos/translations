# WCPOS Translations

AI-powered translation management for WCPOS apps and plugins.

## Structure

- `source/js/` — Extracted English strings from JS monorepo (grouped by tag)
- `source/php/` — Extracted .pot files from WordPress plugins
- `translations/js/{locale}/` — Translated JS strings (JSON)
- `translations/php/{locale}/` — Translated PHP strings (.po, .mo, .l10n.php)
- `scripts/` — Extraction, translation, QA, and generation scripts

## Automated Pipeline

Source repos push strings to this repo via `repository_dispatch`. The pipeline then runs automatically:

1. **Receive** — Source strings committed to main
2. **Translate** — Auto-triggered in `changed` mode (only new/modified strings)
3. **PR** — Created automatically for human review
4. **Release** — Auto-created on merge using CalVer (`YYYY.M.N`)
5. **Update consumers** — This repo opens or updates version-bump PRs in consuming repos

## Versioning

Releases use **CalVer** format: `YYYY.M.N` (e.g., `2026.2.0`, `2026.2.1`).

- `YYYY` — Year
- `M` — Month (no leading zero, semver-compatible)
- `N` — Sequential release number within the month (starts at 0)

Versions are decoupled from plugin/app versions. Each consumer pins the translation version it was built against.

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| Receive JS Strings | `repository_dispatch` | Commit JS source strings, trigger translate |
| Receive PHP Strings | `repository_dispatch` | Commit PHP POT files, trigger translate |
| Translate | Auto or manual | AI translate to all locales (incremental) |
| Translation QA | Manual | Back-translation quality checks |
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

## Aide / OpenClaw Translation Workflow

Aide rules live in `.ai/rules/` and mirror the docs translation learnings for app/plugin translations:

- Use `WCPOS` and `WCPOS Pro` in customer-facing strings; do not use `WooCommerce POS` / `WooCommerce POS Pro` except in technical identifiers such as slugs, filenames, repo names, and URLs.
- Preserve JSON keys, PO `msgid` / `msgctxt`, placeholders, plural suffixes, and technical terms exactly.
- Work in small batches from the machine-readable completeness triage.

Useful commands:

```bash
# Human-readable release gate; exits 1 while release-blocking translation debt remains
node scripts/check-completeness.js

# Machine-readable triage for Aide/OpenClaw; exits 0 for task planning
pnpm --silent run check:completeness:json

# Heuristic quality smoke check for recent translation changes
pnpm run qa:quality -- --changed-since origin/main

# GitHub Actions annotations and markdown summary, used by the Translation Quality Smoke Check workflow
pnpm --silent run qa:quality -- --changed-since origin/main --github-annotations
pnpm --silent run qa:quality -- --changed-since origin/main --markdown
```

The JSON report contains top grouped issues under:

- `missing_js_keys` — release-blocking missing JSON translations
- `php_untranslated` — release-blocking empty/missing PO translations
- `stale_js_keys` — warning-only stale JSON entries
- `naming_violation` — warning-only product naming debt

Recommended order: fix `missing_js_keys` and `php_untranslated` first, run the quality smoke check and review every warning, then clean `naming_violation`, `stale_js_keys`, and PO header warnings. Translation batches should always be pushed to a branch and opened as a PR so Aide work is never left only in a local working tree.

## Local Development

```bash
pnpm install

# Extract source strings
pnpm run extract:js
pnpm run extract:php

# Translate a single locale
OPENAI_API_KEY=sk-... pnpm run translate -- de

# Generate .mo and .l10n.php
pnpm run generate:php

# QA check
OPENAI_API_KEY=sk-... pnpm run qa -- de --structural-only
```

## License

The tooling, scripts, and configuration in this repository are licensed under [MIT](./LICENSE). The generated translation files under `translations/` and the extracted sources under `source/` are derived from their upstream WordPress plugins and retain those projects' original licenses (GPL-3.0-or-later for the WooCommerce POS PHP plugins). MIT applies to this repository's original tooling, not to the translated plugin strings.
