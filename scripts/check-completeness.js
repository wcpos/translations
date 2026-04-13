#!/usr/bin/env node

/**
 * Check translation completeness and placeholder integrity.
 *
 * Verifies:
 * 1. Every locale in locales.json has all expected JS and PHP translation files
 * 2. Every JS translation file has all keys from the corresponding source file
 * 3. Every PHP .po file has no empty msgstr entries (excluding header)
 * 4. JS placeholder tokens ({foo}) in source appear in translations
 * 5. PHP printf placeholders (%s, %d, %1$s) in msgid appear in msgstr
 *
 * Usage: node scripts/check-completeness.js [--warn-only]
 *
 * Exit code 1 on any completeness failure (unless --warn-only).
 */

const fs = require("fs");
const path = require("path");
const gettextParser = require("gettext-parser");

const ROOT = path.resolve(__dirname, "..");
const LOCALES = JSON.parse(
  fs.readFileSync(path.join(ROOT, "locales.json"), "utf8")
);
const LOCALE_CODES = Object.keys(LOCALES);

// English locales don't need translations
const ENGLISH_LOCALES = new Set(["en", "en_US", "en_GB"]);
const TRANSLATABLE_LOCALES = LOCALE_CODES.filter(
  (l) => !ENGLISH_LOCALES.has(l)
);

// Discover JS source files
const JS_SOURCE_DIR = path.join(ROOT, "source/js");
const JS_PROJECTS = fs
  .readdirSync(JS_SOURCE_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({
    name: d.name,
    files: fs
      .readdirSync(path.join(JS_SOURCE_DIR, d.name))
      .filter((f) => f.endsWith(".json")),
  }));

// Discover PHP source files
const PHP_SOURCE_DIR = path.join(ROOT, "source/php");
const PHP_POTS = fs
  .readdirSync(PHP_SOURCE_DIR)
  .filter((f) => f.endsWith(".pot"));

const JS_TRANSLATIONS_DIR = path.join(ROOT, "translations/js");
const PHP_TRANSLATIONS_DIR = path.join(ROOT, "translations/php");

const errors = [];
const warnings = [];

function error(msg) {
  errors.push(msg);
  console.error("  ERROR: " + msg);
}

function warn(msg) {
  warnings.push(msg);
  console.warn("  WARN:  " + msg);
}

// ── JS completeness ─────────────────────────────────────────────────────────

function checkJsCompleteness() {
  console.log("\n== JS Translation Completeness ==\n");

  for (const project of JS_PROJECTS) {
    for (const sourceFile of project.files) {
      const sourcePath = path.join(JS_SOURCE_DIR, project.name, sourceFile);
      const sourceStrings = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      const sourceKeys = Object.keys(sourceStrings);

      for (const locale of TRANSLATABLE_LOCALES) {
        const translationPath = path.join(
          JS_TRANSLATIONS_DIR, locale, project.name, sourceFile
        );

        // File existence
        if (!fs.existsSync(translationPath)) {
          error("Missing file: " + locale + "/" + project.name + "/" + sourceFile);
          continue;
        }

        let translations;
        try {
          translations = JSON.parse(fs.readFileSync(translationPath, "utf8"));
        } catch (e) {
          error("Invalid JSON: " + locale + "/" + project.name + "/" + sourceFile + " — " + e.message);
          continue;
        }

        // Missing keys
        const missingKeys = sourceKeys.filter((k) => !(k in translations));
        if (missingKeys.length > 0) {
          const examples = missingKeys.slice(0, 3).join(", ");
          const suffix = missingKeys.length > 3 ? "..." : "";
          error(locale + "/" + project.name + "/" + sourceFile + ": " +
            missingKeys.length + " missing keys — " + examples + suffix);
        }

        // Placeholder integrity: {foo} tokens
        for (const key of sourceKeys) {
          if (!(key in translations)) continue;
          const srcPH = (sourceStrings[key].match(/\{[^}]+\}/g) || []).sort();
          const trnPH = (translations[key].match(/\{[^}]+\}/g) || []).sort();
          if (srcPH.join(",") !== trnPH.join(",")) {
            error(locale + "/" + project.name + "/" + sourceFile + ":" + key +
              " — placeholder mismatch: source [" + srcPH + "], translation [" + trnPH + "]");
          }
        }

        // Stale keys (in translation but not in source)
        const staleKeys = Object.keys(translations).filter((k) => !(k in sourceStrings));
        if (staleKeys.length > 0) {
          const examples = staleKeys.slice(0, 3).join(", ");
          const suffix = staleKeys.length > 3 ? "..." : "";
          warn(locale + "/" + project.name + "/" + sourceFile + ": " +
            staleKeys.length + " stale keys — " + examples + suffix);
        }
      }
    }
  }
}

// ── PHP completeness ─────────────────────────────────────────────────────────

function checkPhpCompleteness() {
  console.log("\n== PHP Translation Completeness ==\n");

  for (const potFile of PHP_POTS) {
    const domain = potFile.replace(/\.pot$/, "");
    const potPath = path.join(PHP_SOURCE_DIR, potFile);
    const potContent = fs.readFileSync(potPath);
    const pot = gettextParser.po.parse(potContent);
    const potEntries = [];
    for (const [context, contextEntries] of Object.entries(pot.translations || {})) {
      for (const [msgid, entry] of Object.entries(contextEntries || {})) {
        if (msgid === "") continue;
        potEntries.push({ context, msgid, entry });
      }
    }
    const totalStrings = potEntries.length;

    for (const locale of TRANSLATABLE_LOCALES) {
      const poFile = domain + "-" + locale + ".po";
      const poPath = path.join(PHP_TRANSLATIONS_DIR, locale, poFile);

      // File existence
      if (!fs.existsSync(poPath)) {
        error("Missing file: " + locale + "/" + poFile);
        continue;
      }

      let po;
      try {
        po = gettextParser.po.parse(fs.readFileSync(poPath));
      } catch (e) {
        error("Invalid PO: " + locale + "/" + poFile + " — " + e.message);
        continue;
      }

      const translationsByContext = po.translations || {};

      // Count empty msgstr (untranslated)
      let untranslated = 0;
      const untranslatedExamples = [];

      for (const { context, msgid } of potEntries) {
        const translations = translationsByContext[context] || {};
        const entry = translations[msgid];
        const msgidLabel = context ? "[" + context + "] " + msgid : msgid;
        if (!entry) {
          untranslated++;
          if (untranslatedExamples.length < 3) {
            untranslatedExamples.push(msgidLabel.slice(0, 60));
          }
          continue;
        }

        const msgstr = entry.msgstr || [];
        const hasEmptyForm = msgstr.some((s) => !s || s.trim() === "");
        if (hasEmptyForm) {
          untranslated++;
          if (untranslatedExamples.length < 3) {
            untranslatedExamples.push(msgidLabel.slice(0, 60));
          }
        }
      }

      if (untranslated > 0) {
        error(locale + "/" + poFile + ": " + untranslated + "/" + totalStrings +
          " untranslated — e.g. " + untranslatedExamples.join("; "));
      }

      // PHP placeholder integrity: %s, %d, %1$s, etc.
      // Check each plural form independently (joining forms creates false positives)
      for (const { context, msgid, entry: potEntry } of potEntries) {
        const translations = translationsByContext[context] || {};
        const entry = translations[msgid];
        if (!entry) continue;
        const forms = entry.msgstr || [];
        if (forms.every((s) => !s || s.trim() === "")) continue;

        for (let fi = 0; fi < forms.length; fi++) {
          const form = forms[fi];
          if (!form || form.trim() === "") continue;
          const sourceText = fi === 0
            ? msgid
            : (potEntry.msgid_plural || entry.msgid_plural || msgid);
          const srcPH = (sourceText.match(/%(?:\d+\$)?[sdfb]/g) || []).sort();
          if (srcPH.length === 0) continue;
          const trnPH = (form.match(/%(?:\d+\$)?[sdfb]/g) || []).sort();
          if (srcPH.join(",") !== trnPH.join(",")) {
            const formLabel = forms.length > 1 ? " [form " + fi + "]" : "";
            const msgidLabel = context ? "[" + context + "] " + msgid : msgid;
            error(locale + "/" + poFile + ": placeholder mismatch in \"" +
              msgidLabel.slice(0, 50) + "\"" + formLabel + " — source [" + srcPH + "], translation [" + trnPH + "]");
          }
        }
      }

      // Check .l10n.php exists
      const l10nFile = domain + "-" + locale + ".l10n.php";
      const l10nPath = path.join(PHP_TRANSLATIONS_DIR, locale, l10nFile);
      if (!fs.existsSync(l10nPath)) {
        error("Missing file: " + locale + "/" + l10nFile);
      }

      // Check .mo exists
      const moFile = domain + "-" + locale + ".mo";
      const moPath = path.join(PHP_TRANSLATIONS_DIR, locale, moFile);
      if (!fs.existsSync(moPath)) {
        warn("Missing file: " + locale + "/" + moFile + " (optional but recommended)");
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const warnOnly = process.argv.includes("--warn-only");

  console.log("Translation Completeness Check");
  console.log(
    "Locales: " + TRANSLATABLE_LOCALES.length + " translatable (" +
    ENGLISH_LOCALES.size + " English excluded)"
  );
  console.log(
    "JS: " + JS_PROJECTS.map((p) => p.name + " (" + p.files.length + " files)").join(", ")
  );
  console.log("PHP: " + PHP_POTS.join(", "));

  checkJsCompleteness();
  checkPhpCompleteness();

  console.log("\n== Summary ==");
  console.log("Errors:   " + errors.length);
  console.log("Warnings: " + warnings.length);

  if (errors.length > 0 && !warnOnly) {
    console.error("\n" + errors.length + " error(s) found. Fix before releasing.");
    process.exit(1);
  }
}

main();
