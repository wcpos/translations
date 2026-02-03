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

## Plural Handling (Action Required)

### Current State (Not Ideal)

The codebase currently uses separate strings for singular/plural:

```typescript
// Current approach
const message = count === 1
  ? t('1 product found locally')
  : t('{count} products found locally', { count });
```

This works for languages with 2 plural forms but fails for:
- **Russian**: 4 forms (one, few, many, other)
- **Arabic**: 6 forms
- **Polish**: 3 forms

### Recommended Change

Use i18next's built-in plural handling:

```typescript
// Better approach
t('product_found_locally', { count })
```

With translation keys:
```json
{
  "product_found_locally_one": "{count} product found locally",
  "product_found_locally_other": "{count} products found locally"
}
```

For Russian, translators would provide:
```json
{
  "product_found_locally_one": "{count} продукт найден локально",
  "product_found_locally_few": "{count} продукта найдено локально",
  "product_found_locally_many": "{count} продуктов найдено локально",
  "product_found_locally_other": "{count} продукта найдено локально"
}
```

### Strings That Need Updating

| Current Singular | Current Plural | Suggested Key |
|-----------------|----------------|---------------|
| `1 product found locally` | `{count} products found locally` | `product_found_locally` |
| `1 variation found for {term}` | `{count} variations found for {term}` | `variation_found_for_term` |

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

Example loader:
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

// Usage
await loadTranslations('de_DE', 'monorepo', 'core');
```

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
