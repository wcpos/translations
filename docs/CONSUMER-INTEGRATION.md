# Consumer Integration Guide

When translations are updated and merged, this repo automatically creates a CalVer release (e.g., `2026.2.0`) and dispatches a `translation-release` event to all consuming repos with the new version in the payload.

Each consuming repo needs a workflow to receive this event and update its translation version constant.

## How It Works

1. Translation PR is merged to main
2. Release workflow auto-creates a CalVer tag and GitHub Release
3. `repository_dispatch` event sent to your repo with `{ "version": "2026.2.0" }`
4. Your receiver workflow updates the version constant in your codebase

## Receiver Workflow Template

Add this workflow to your repo at `.github/workflows/update-translations.yml`:

```yaml
name: Update Translation Version

on:
  repository_dispatch:
    types: [translation-release]

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Update translation version
        run: |
          VERSION="${{ github.event.client_payload.version }}"
          echo "Updating translation version to $VERSION"

          # ================================================
          # REPLACE THIS with your project-specific command.
          # See examples below for each project.
          # ================================================

      - name: Commit and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .
          if ! git diff --staged --quiet; then
            git commit -m "chore: update translation version to ${{ github.event.client_payload.version }}"
            git push
          fi
```

---

## Project-Specific Instructions

### Monorepo (React Native / Electron)

**What you need**: A `TRANSLATION_VERSION` constant that your i18next loader uses to build jsDelivr URLs.

**Where to store it**: Wherever your app config lives (e.g., `src/config.ts`, `.env`, `app.config.ts`).

**Example constant**:
```typescript
export const TRANSLATION_VERSION = '2026.2.0';
```

**Example loader**:
```typescript
import { TRANSLATION_VERSION } from './config';

const loadTranslations = async (locale: string, namespace: string) => {
  const url = `https://cdn.jsdelivr.net/gh/wcpos/translations@${TRANSLATION_VERSION}/translations/js/${locale}/monorepo/${namespace}.json`;
  const response = await fetch(url);
  return response.json();
};
```

**Receiver workflow update command**:
```bash
# Adjust the file path and pattern to match your codebase
sed -i "s/TRANSLATION_VERSION = '.*'/TRANSLATION_VERSION = '${VERSION}'/" src/config.ts
```

---

### Free Plugin (woocommerce-pos)

**What you need**:
- A PHP constant for the translation version (used for JS admin translations via jsDelivr)
- PHP translation files (.mo, .l10n.php) bundled at release time

**PHP constant**:
```php
define('WCPOS_TRANSLATION_VERSION', '2026.2.0');
```

**JS admin translations** (wp-admin settings page):
```php
wp_localize_script('wcpos-settings', 'wcposI18n', [
    'translationUrl' => sprintf(
        'https://cdn.jsdelivr.net/gh/wcpos/translations@%s/translations/js/%%s/woocommerce-pos/wp-admin-settings.json',
        WCPOS_TRANSLATION_VERSION
    ),
]);
```

**Receiver workflow update command**:
```bash
# Adjust the file path and pattern to match your codebase
sed -i "s/WCPOS_TRANSLATION_VERSION', '.*'/WCPOS_TRANSLATION_VERSION', '${VERSION}'/" includes/constants.php
```

**Bundling PHP translations at release time**:
```bash
# Download .mo and .l10n.php files from the translation release
VERSION="${{ github.event.client_payload.version }}"
gh release download "$VERSION" \
  --repo wcpos/translations \
  --pattern "*.mo" \
  --pattern "*.l10n.php" \
  --dir languages/
```

---

### Pro Plugin (woocommerce-pos-pro)

Same pattern as the free plugin:

**PHP constant**:
```php
define('WCPOS_PRO_TRANSLATION_VERSION', '2026.2.0');
```

**JS admin translations** (analytics page):
```php
wp_localize_script('wcpos-analytics', 'wcposProI18n', [
    'translationUrl' => sprintf(
        'https://cdn.jsdelivr.net/gh/wcpos/translations@%s/translations/js/%%s/woocommerce-pos-pro/wp-admin-analytics.json',
        WCPOS_PRO_TRANSLATION_VERSION
    ),
]);
```

**Receiver workflow update command**:
```bash
sed -i "s/WCPOS_PRO_TRANSLATION_VERSION', '.*'/WCPOS_PRO_TRANSLATION_VERSION', '${VERSION}'/" includes/constants.php
```

---

## CalVer Format

Translation versions use `YYYY.M.N`:
- `2026.2.0` — First release in February 2026
- `2026.2.1` — Second release in February 2026
- `2026.10.0` — First release in October 2026

No leading zeros. Semver-compatible (works with jsDelivr version resolution and cache purging).

## Testing the Integration

1. Check the latest translation release: `gh release view --repo wcpos/translations`
2. Verify jsDelivr serves the files: `curl https://cdn.jsdelivr.net/gh/wcpos/translations@{version}/translations/js/de_DE/monorepo/core.json`
3. Confirm your receiver workflow ran: check your repo's Actions tab for `Update Translation Version` runs
