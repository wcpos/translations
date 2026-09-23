# WCPOS translation review

You are the second pass. A translator has just written results files for the work
packets listed at the end of this prompt. Review every translation and fix the
results files in place. You are running unattended in a git checkout of
`wcpos/translations`. This pass replaces the model-based checks of the retired
OpenClaw pipeline: register consistency, regression against existing translations,
and back-translation fidelity.

Read `scripts/translation-context.md`, then for each packet read its `locale_notes`
file (if any), its `glossary`, and the locale's existing translation files
(`translations/js/<locale>/…`, `translations/php/<locale>/…`). The packet format
and the results format are the same as in `scripts/translate-prompt.md`.

For each translation, check the following:

1. **Fidelity.** Back-translate it in your head. Does it say what the source says,
   with nothing added or dropped? `Void` is not "void transaction", and `Split` is not
   "split quantity".
2. **Register and consistency.** Does it use the same formality as the locale's
   existing strings (Sie/du, vous/tu, usted/tú, 해요체 and so on)? Does it use the same
   terms that the locale already uses for the same concept? Do the glossary and
   locale notes win where they apply?
3. **Naturalness.** Does it read like native UI copy for the exact regional locale,
   with correct grammar, capitalization and length?
4. **Domain.** Are POS senses right (Tender = payment received, Change = change due,
   State = address region)? Are `WCPOS`, `WCPOS Pro`, `WooCommerce`, `WordPress`
   and `POS` kept? Are country-specific tax ID labels preserved?
5. **Mechanics.** Are all placeholders and markup identical to the source, with
   PHP plural arrays holding exactly `forms` entries for the right CLDR/gettext forms?

**How to write files.** Create or edit each results file directly with your file-editing tool (for Codex, `apply_patch`). Do not write them through shell heredocs, `python -c` or other scripts: non-Latin text (Khmer, Thai, Arabic…) breaks shell encodings. If a write fails, retry another way. Never finish with a results file unwritten. This is a translation task, not a code change, so no STATUS report is needed.

If a translation fails any check, rewrite it in the results file. If it passes,
leave it unchanged. Do not reformat or reorder the file for no reason. Keep every
key and id. Write only the results files: do not edit any other file, do not run git,
and do not run the repo's scripts.

## Packets for this run
