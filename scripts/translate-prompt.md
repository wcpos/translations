# WCPOS translation run

You are translating user-interface strings for WCPOS, a point-of-sale app for
WooCommerce, into the locales listed at the end of this prompt. You are running
unattended inside a git checkout of `wcpos/translations`. A deterministic script
chose the strings; another will validate and apply what you write. Your only job
is to produce excellent translations in the results files.

## Read first

1. `scripts/translation-context.md` is the quality contract: POS terminology, terms
   that stay in English, placeholder rules and ambiguous short strings. Read it in full once.
2. For each work packet, read the file named in its `locale_notes` field, if there is one.
   Locale notes and the packet's `glossary` override the general context for that
   locale.
3. When a string is ambiguous, look at how the same locale already translates
   related keys: `translations/js/<locale>/<project>/<file>.json` for JS and
   `translations/php/<locale>/<domain>-<locale>.po` for PHP. Stay consistent with
   established terminology unless the glossary or locale notes say otherwise.

## Work packets

Each line at the end of this prompt reads `- <work packet> -> <results file>`.
A packet (`.translate/work/<locale>.json`) contains:

- `locale`, `locale_name`: the exact regional locale. Translate for that region, so
  `es_MX` is not `es_ES` and `fr_CA` is not `fr_FR`.
- `js["<project>/<file>.json"]["<key>"] = { source, plural_category?, concepts }`.
  `plural_category` (`zero`/`one`/`two`/`few`/`many`/`other`) means that the key is
  the i18next plural form for that CLDR category. Translate the source as that form
  in this locale. The key name often hints at where the string appears.
- `php["<domain>"].entries[] = { id, msgctxt?, msgid, msgid_plural?, forms, translator_notes, references, concepts }`.
  `forms` is the number of gettext plural forms that this locale needs. `plural_expression`
  says which `n` values each index covers. Singular entries have `forms: 1`.
- `concepts`: disambiguation hints for words like Tender, Change, Void, Key and State.
  Follow the meaning, and never use a listed `avoid_meanings` sense.

## Results files

Write exactly one JSON file per packet, at the given results path, with this shape:

```json
{
  "locale": "<locale>",
  "js":  { "<project>/<file>.json": { "<key>": "<translation>" } },
  "php": { "<id>": ["<form 0>", "<form 1>"] }
}
```

- Include every key and every `id` from the packet, with no additions.
- PHP values are always arrays with exactly `forms` non-empty strings.
- Preserve placeholders exactly: `{name}`, `{{name}}`, `%s`, `%d`, `%1$s`, `%2$s`
  and `%%`. Positional printf arguments may move within the sentence. Curly
  placeholder names never change.
- Preserve markup tags and attributes exactly, for example `<strong>`, `<a href="%s">`
  and `<link>`. Translate only the text between tags.
- Write `WCPOS` / `WCPOS Pro` for the product, never `WooCommerce POS`.
- Use natural target-language UI copy, not English word order. Follow the locale's
  capitalization conventions and keep the length close to the source.

## Rules

**How to write files.** Create or edit each results file directly with your file-editing tool (for Codex, `apply_patch`). Do not write them through shell heredocs, `python -c` or other scripts: non-Latin text (Khmer, Thai, Arabic…) breaks shell encodings. If a write fails, retry another way. Never finish with a results file unwritten. This is a translation task, not a code change, so no STATUS report is needed.

- Write only the results files. Do not edit any other file, do not run git, and do
  not run the repo's scripts. Validation happens after you finish.
- If you cannot translate an item confidently, still give your best translation.
  A reviewer checks the pull request, and an omitted item stays untranslated
  until the next run.
- Before finishing, re-read each results file and check that it parses as JSON, that
  it has every key and id, and that every placeholder is intact.

## Packets for this run
