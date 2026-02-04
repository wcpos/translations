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
5. **Notify** — Consuming repos receive the new version via `repository_dispatch`

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
| Release | Auto on merge or manual | CalVer tag + GitHub Release + notify consumers |

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
