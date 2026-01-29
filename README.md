# WCPOS Translations

AI-powered translation management for WCPOS apps and plugins.

## Structure

- `source/js/` — Extracted English strings from JS monorepo (grouped by tag)
- `source/php/` — Extracted .pot files from WordPress plugins
- `translations/js/{locale}/` — Translated JS strings (JSON)
- `translations/php/{locale}/` — Translated PHP strings (.po, .mo, .l10n.php)
- `scripts/` — Extraction, translation, QA, and generation scripts

## Workflows

| Workflow | Purpose |
|----------|---------|
| Extract JS Strings | Parse `t()` calls from monorepo |
| Extract PHP Strings | Generate .pot from plugins |
| Translate | AI translate to all locales (incremental) |
| Translation QA | Back-translation quality checks |
| Release | Tag + GitHub Release for jsDelivr CDN |

## JS Distribution (jsDelivr)

```
https://cdn.jsdelivr.net/gh/wcpos/translations@v1.0.0/translations/js/{locale}/{tag}.json
```

## PHP Distribution

PHP translation files (.mo, .l10n.php) are attached to GitHub Releases and can be fetched by the plugin's translation updater.

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
