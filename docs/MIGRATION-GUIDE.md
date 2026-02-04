# Transifex to react-i18next Migration Guide

This document outlines what the monorepo team needs to know when consuming translations from this repo.

## Current Translation Format

**Source strings** are extracted from `t()` calls and `<Trans>` components.

**Output format** (per locale):
```json
{
  "Add to Cart": "In den Warenkorb legen",
  "Hello {name}": "Hallo {name}",
  "{count} products found": "{count} Produkte gefunden"
}
```

The English source string is the key, the translation is the value.

---

## i18next Configuration Required

The translations use `{variable}` placeholders (not i18next's default `{{variable}}`). Configure i18next accordingly:

```typescript
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

i18n.use(initReactI18next).init({
  interpolation: {
    prefix: '{',
    suffix: '}',
    escapeValue: false, // React handles escaping
  },
  // Use source strings as keys
  keySeparator: false,
  nsSeparator: false,

  // Fallback to key (English source) if translation missing
  fallbackLng: false,
  returnEmptyString: false,
});
```

---

## Placeholder Format

Use single braces in translation strings:

```typescript
// Correct
t('Hello {name}', { name: userName })
t('{count} items in cart', { count: itemCount })

// Wrong - don't use double braces
t('Hello {{name}}', { name: userName })
```

---

## Plural Handling

The translation system uses i18next's built-in plural handling with CLDR plural rules.

### Usage in Code

```typescript
// i18next automatically selects the correct plural form based on count
t('product_found_locally', { count: 1 })  // uses _one
t('product_found_locally', { count: 5 })  // uses _other (or _many for Russian)
```

### Translation Keys

Plural keys use suffixes: `_zero`, `_one`, `_two`, `_few`, `_many`, `_other`

**English (2 forms):**
```json
{
  "product_found_locally_one": "{count} product found locally",
  "product_found_locally_other": "{count} products found locally"
}
```

**Russian (4 forms):**
```json
{
  "product_found_locally_one": "{count} продукт найден локально",
  "product_found_locally_few": "{count} продукта найдено локально",
  "product_found_locally_many": "{count} продуктов найдено локально",
  "product_found_locally_other": "{count} продукта найдено локально"
}
```

### Plural Suffixes by Locale

| Locale Group | Suffixes |
|--------------|----------|
| East Asian (ja, zh_CN, zh_TW, ko_KR, vi, th, id_ID, ms_MY) | `other` |
| Germanic, Romance (de, fr, es, it, pt, nl, sv, da, no, el, he, hi, hu, tr, fa) | `one`, `other` |
| Slavic (ru, uk, pl, cs) | `one`, `few`, `many`, `other` |
| Romanian | `one`, `few`, `other` |
| Arabic | `zero`, `one`, `two`, `few`, `many`, `other` |

### Current Plural Strings

| Base Key | Description |
|----------|-------------|
| `product_found_locally` | Barcode scan result count |
| `variation_found_for_term` | Product variation search count |

---

## Namespace Organization

Strings are organized by namespace based on file location:

| Path Pattern | Namespace |
|-------------|-----------|
| `packages/core/` | `core` |
| `apps/electron/` | `electron` |

To use a specific namespace:
```typescript
t('Some string', { ns: 'electron' })
```

Or with the `_tags` legacy option:
```typescript
t('Some string', { _tags: 'electron' })
```

---

## Loading Translations

Translation files mirror the source structure:
```
translations/js/{locale}/{project}/{namespace}.json
```

**Projects:**
| Project | Description |
|---------|-------------|
| `monorepo` | WCPOS React Native app (core + electron namespaces) |
| `woocommerce-pos` | WordPress plugin (free) |
| `woocommerce-pos-pro` | WordPress plugin (pro) |

**Example paths:**
- `translations/js/de_DE/monorepo/core.json`
- `translations/js/de_DE/monorepo/electron.json`
- `translations/js/de_DE/woocommerce-pos/wp-admin-settings.json`
- `translations/js/de_DE/woocommerce-pos-pro/wp-admin-analytics.json`

### Production (jsDelivr CDN)

Use a pinned translation version for production. The version uses CalVer format (`YYYY.M.N`) and is decoupled from plugin/app versions.

```typescript
// TRANSLATION_VERSION is set at build time, updated automatically
// via repository_dispatch from the translations repo
const TRANSLATION_VERSION = '2026.2.0';

const loadTranslations = async (
  locale: string,
  project: string,
  namespace: string
) => {
  const url = `https://cdn.jsdelivr.net/gh/wcpos/translations@${TRANSLATION_VERSION}/translations/js/${locale}/${project}/${namespace}.json`;
  const response = await fetch(url);
  return response.json();
};

// Usage
await loadTranslations('de_DE', 'monorepo', 'core');
```

### Development (GitHub raw)

For development, load directly from the main branch:

```typescript
const loadTranslations = async (
  locale: string,
  project: string,
  namespace: string
) => {
  const url = `https://raw.githubusercontent.com/wcpos/translations/main/translations/js/${locale}/${project}/${namespace}.json`;
  const response = await fetch(url);
  return response.json();
};
```

See [CONSUMER-INTEGRATION.md](CONSUMER-INTEGRATION.md) for details on receiving automatic version updates.

---

## Available Locales

See [locales.json](../locales.json) for the full list (36 locales).

Common ones:
- `en_GB`, `de_DE`, `fr_FR`, `es_ES`, `it_IT`
- `ja`, `zh_CN`, `zh_TW`, `ko_KR`
- `pt_BR`, `ru_RU`, `ar`

---

## Testing

Run format validation:
```bash
pnpm test:i18next
```

This checks:
- JSON structure is valid
- Placeholders preserved in translations
- Keys match source strings

---

## Questions?

File an issue at https://github.com/wcpos/translations/issues
