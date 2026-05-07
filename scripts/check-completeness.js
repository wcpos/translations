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
 * Usage: node scripts/check-completeness.js [--warn-only] [--json]
 *
 * Exit code 1 on any completeness failure (unless --warn-only).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const gettextParser = require("gettext-parser");
const { expectedKeysForLocale, parsePluralKey } = require("./plural-rules");

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
const cliOptions = parseCliOptions(process.argv.slice(2));
const changedScope = cliOptions.changedSince
  ? buildChangedScope(cliOptions.changedSince)
  : null;
const triageSummary = createTriageSummary();


function parseCliOptions(args) {
  const options = {
    json: args.includes("--json"),
    changedSince: null,
    githubAnnotations: args.includes("--github-annotations"),
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--changed-since") {
      options.changedSince = args[index + 1] || null;
      index++;
    } else if (arg.startsWith("--changed-since=")) {
      options.changedSince = arg.slice("--changed-since=".length);
    }
  }

  return options;
}

function gitChangedFiles(baseRef) {
  try {
    return execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Unable to determine changed files from ${baseRef}: ${error.message}`);
  }
}

function buildChangedScope(baseRef) {
  const changedFiles = gitChangedFiles(baseRef);
  const jsTranslationFiles = new Set();
  const phpPoFiles = new Set();
  const phpL10nFiles = new Set();
  let sourceOrScriptChanged = false;

  for (const file of changedFiles) {
    if (file.startsWith("translations/js/") && file.endsWith(".json")) {
      jsTranslationFiles.add(file);
    } else if (file.startsWith("translations/php/") && file.endsWith(".po")) {
      phpPoFiles.add(file);
    } else if (file.startsWith("translations/php/") && file.endsWith(".l10n.php")) {
      phpL10nFiles.add(file);
    } else if (file.startsWith("source/")) {
      sourceOrScriptChanged = true;
    }
  }

  return {
    baseRef,
    changedFiles,
    jsTranslationFiles,
    phpPoFiles,
    phpL10nFiles,
    sourceOrScriptChanged,
  };
}

function toRepoRelativePath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function shouldCheckJsTranslationFile(filePath) {
  if (!changedScope) return true;
  if (changedScope.sourceOrScriptChanged) return true;
  return changedScope.jsTranslationFiles.has(toRepoRelativePath(filePath));
}

function shouldCheckPhpPoFile(filePath) {
  if (!changedScope) return true;
  if (changedScope.sourceOrScriptChanged) return true;
  return changedScope.phpPoFiles.has(toRepoRelativePath(filePath));
}

function formatGitHubAnnotation(level, message) {
  if (!cliOptions.githubAnnotations) return;
  const escaped = message
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.log(`::${level}::${escaped}`);
}

function createTriageSummary() {
  return {
    missing_js_keys: new Map(),
    stale_js_keys: new Map(),
    php_untranslated: new Map(),
    naming_violation: new Map(),
  };
}

function recordTriageIssue(summary, category, key, count = 1) {
  if (!summary[category]) {
    summary[category] = new Map();
  }
  summary[category].set(key, (summary[category].get(key) || 0) + count);
}

function findWcposNamingIssues(value) {
  if (typeof value !== "string" || value.trim() === "") return [];

  const issues = [];
  const withoutPro = value.replace(/WooCommerce POS Pro/g, "");

  if (value.includes("WooCommerce POS Pro")) {
    issues.push('Use "WCPOS Pro" instead of "WooCommerce POS Pro"');
  }
  if (withoutPro.includes("WooCommerce POS")) {
    issues.push('Use "WCPOS" instead of "WooCommerce POS"');
  }

  return issues;
}

function error(msg) {
  errors.push(msg);
  formatGitHubAnnotation("error", msg);
  if (!cliOptions.json) console.error("  ERROR: " + msg);
}

function warn(msg) {
  warnings.push(msg);
  formatGitHubAnnotation("warning", msg);
  if (!cliOptions.json) console.warn("  WARN:  " + msg);
}

function log(msg = "") {
  if (!cliOptions.json) console.log(msg);
}

// ── JS completeness ─────────────────────────────────────────────────────────

function checkJsCompleteness() {
  log("\n== JS Translation Completeness ==\n");

  for (const project of JS_PROJECTS) {
    for (const sourceFile of project.files) {
      const sourcePath = path.join(JS_SOURCE_DIR, project.name, sourceFile);
      let sourceStrings;
      try {
        sourceStrings = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      } catch (e) {
        error("Invalid source JSON: " + project.name + "/" + sourceFile + " — " + e.message);
        continue;
      }
      if (!sourceStrings || typeof sourceStrings !== "object" || Array.isArray(sourceStrings)) {
        error("Invalid source format: " + project.name + "/" + sourceFile + " — expected JSON object");
        continue;
      }
      const sourceKeys = Object.keys(sourceStrings);

      for (const locale of TRANSLATABLE_LOCALES) {
        const translationPath = path.join(
          JS_TRANSLATIONS_DIR, locale, project.name, sourceFile
        );

        if (!shouldCheckJsTranslationFile(translationPath)) {
          continue;
        }

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
        if (!translations || typeof translations !== "object" || Array.isArray(translations)) {
          error("Invalid translation format: " + locale + "/" + project.name + "/" + sourceFile + " — expected JSON object");
          continue;
        }

        // Compute locale-aware expected keys (respects CLDR plural rules)
        const expected = expectedKeysForLocale(sourceKeys, locale);

        // Missing keys
        const missingKeys = [...expected].filter((k) => !(k in translations));
        if (missingKeys.length > 0) {
          const examples = missingKeys.slice(0, 3).join(", ");
          const suffix = missingKeys.length > 3 ? "..." : "";
          recordTriageIssue(triageSummary, "missing_js_keys", project.name + "/" + sourceFile, missingKeys.length);
          error(locale + "/" + project.name + "/" + sourceFile + ": " +
            missingKeys.length + " missing keys — " + examples + suffix);
        }

        // Placeholder integrity: {foo} tokens
        // Check all expected keys, including generated plural forms (_two, _few, etc.)
        for (const key of expected) {
          if (!(key in translations)) continue;
          if (typeof translations[key] !== "string") continue;

          // Find the source string: either directly in source, or from a sibling plural form
          let sourceText = sourceStrings[key];
          if (typeof sourceText !== "string") {
            const parsed = parsePluralKey(key);
            if (parsed) {
              // Look for any sibling plural form in source (e.g. _one or _other)
              for (const sk of sourceKeys) {
                const sp = parsePluralKey(sk);
                if (sp && sp.base === parsed.base) {
                  sourceText = sourceStrings[sk];
                  break;
                }
              }
            }
          }
          if (typeof sourceText !== "string") continue;

          const srcPH = (sourceText.match(/\{[^}]+\}/g) || []).sort();
          const trnPH = (translations[key].match(/\{[^}]+\}/g) || []).sort();
          if (srcPH.join(",") !== trnPH.join(",")) {
            error(locale + "/" + project.name + "/" + sourceFile + ":" + key +
              " — placeholder mismatch: source [" + srcPH + "], translation [" + trnPH + "]");
          }

          const namingIssues = findWcposNamingIssues(translations[key]);
          for (const namingIssue of namingIssues) {
            recordTriageIssue(triageSummary, "naming_violation", project.name + "/" + sourceFile);
            warn(locale + "/" + project.name + "/" + sourceFile + ":" + key +
              " — product naming violation: " + namingIssue);
          }
        }

        // Stale keys (in translation but not expected for this locale)
        const staleKeys = Object.keys(translations).filter((k) => !expected.has(k));
        if (staleKeys.length > 0) {
          const examples = staleKeys.slice(0, 3).join(", ");
          const suffix = staleKeys.length > 3 ? "..." : "";
          const message = locale + "/" + project.name + "/" + sourceFile + ": " +
            staleKeys.length + " stale keys — " + examples + suffix;
          recordTriageIssue(triageSummary, "stale_js_keys", project.name + "/" + sourceFile, staleKeys.length);
          if (changedScope) {
            error(message);
          } else {
            warn(message);
          }
        }
      }
    }
  }
}

// ── PHP completeness ─────────────────────────────────────────────────────────

function checkPhpCompleteness() {
  log("\n== PHP Translation Completeness ==\n");

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

      if (!shouldCheckPhpPoFile(poPath)) {
        continue;
      }

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
        recordTriageIssue(triageSummary, "php_untranslated", poFile, untranslated);
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
          const formLabel = forms.length > 1 ? " [form " + fi + "]" : "";
          const msgidLabel = context ? "[" + context + "] " + msgid : msgid;

          const namingIssues = findWcposNamingIssues(form);
          for (const namingIssue of namingIssues) {
            recordTriageIssue(triageSummary, "naming_violation", poFile);
            warn(locale + "/" + poFile + ": product naming violation in \"" +
              msgidLabel.slice(0, 50) + "\"" + formLabel + " — " + namingIssue);
          }

          const srcPH = (sourceText.match(/%(?:\d+\$)?[sdfb]/g) || []).sort();
          if (srcPH.length === 0) continue;
          const trnPH = (form.match(/%(?:\d+\$)?[sdfb]/g) || []).sort();
          if (srcPH.join(",") !== trnPH.join(",")) {
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

function serializeTriageSummary(summary = triageSummary, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 10;
  const serialized = {};

  for (const [category, entries] of Object.entries(summary)) {
    if (!(entries instanceof Map)) {
      serialized[category] = [];
      continue;
    }

    serialized[category] = [...entries.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key, count]) => ({ key, count }));
  }

  return serialized;
}

function printTriageSummary(summary = triageSummary) {
  log("\n== Triage ==");
  const serialized = serializeTriageSummary(summary);
  for (const [category, entries] of Object.entries(serialized)) {
    if (entries.length === 0) continue;
    log("\n" + category + ":");
    for (const { key, count } of entries) {
      log("  " + key + ": " + count);
    }
  }
}

function buildCompletenessReport() {
  return {
    errors: errors.length,
    warnings: warnings.length,
    changed_since: changedScope?.baseRef ?? null,
    changed_files: changedScope?.changedFiles.length ?? null,
    triage: serializeTriageSummary(),
    details: {
      errors,
      warnings,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const warnOnly = process.argv.includes("--warn-only");

  log("Translation Completeness Check");
  if (changedScope) {
    log("Changed-since: " + changedScope.baseRef + " (" + changedScope.changedFiles.length + " changed file(s))");
  }
  log(
    "Locales: " + TRANSLATABLE_LOCALES.length + " translatable (" +
    ENGLISH_LOCALES.size + " English excluded)"
  );
  log(
    "JS: " + JS_PROJECTS.map((p) => p.name + " (" + p.files.length + " files)").join(", ")
  );
  log("PHP: " + PHP_POTS.join(", "));

  checkJsCompleteness();
  checkPhpCompleteness();

  printTriageSummary();

  if (cliOptions.json) {
    console.log(JSON.stringify(buildCompletenessReport(), null, 2));
  } else {
    console.log("\n== Summary ==");
    console.log("Errors:   " + errors.length);
    console.log("Warnings: " + warnings.length);
  }

  if (errors.length > 0 && !warnOnly) {
    if (!cliOptions.json) {
      console.error("\n" + errors.length + " error(s) found. Fix before releasing.");
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  findWcposNamingIssues,
  createTriageSummary,
  recordTriageIssue,
  printTriageSummary,
  serializeTriageSummary,
  buildCompletenessReport,
  parseCliOptions,
  buildChangedScope,
  toRepoRelativePath,
};
