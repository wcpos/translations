#!/usr/bin/env node

/**
 * Generate .mo and .l10n.php files from translated .po files.
 *
 * - .mo: Traditional WordPress binary format
 * - .l10n.php: WordPress 6.5+ PHP translation format (faster loading)
 *
 * Usage:
 *   node scripts/generate-php-files.js [locale]
 *
 * If no locale specified, generates for all locales.
 */

const fs = require('fs');
const path = require('path');
const gettextParser = require('gettext-parser');
const { globSync } = require('glob');

const TRANSLATIONS_PHP_DIR = path.resolve(__dirname, '../translations/php');

/**
 * Generate .l10n.php content from parsed PO data.
 * WordPress 6.5+ loads this format natively — much faster than .mo parsing.
 */
function generateL10nPhp(po) {
  const entries = [];

  for (const [ctx, messages] of Object.entries(po.translations)) {
    for (const [msgid, entry] of Object.entries(messages)) {
      if (!msgid) continue; // Skip header

      const msgstr = entry.msgstr || [];
      if (!msgstr[0]) continue; // Skip untranslated

      // Build the key: context\x04msgid or just msgid
      const key = ctx ? `${ctx}\x04${msgid}` : msgid;

      // For plural forms, join with \x00
      const value = msgstr.length > 1 ? msgstr.join('\x00') : msgstr[0];

      entries.push({ key, value });
    }
  }

  // Generate PHP array in WordPress 6.5+ format.
  // WordPress expects: array( 'messages' => array( key => value, ... ) )
  let php = `<?php\nreturn array(\n\t'messages' => array(\n`;

  for (const { key, value } of entries) {
    const escapedKey = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    // Restore \x04 and \x00 as actual bytes
    const phpKey = escapedKey.replace(/\x04/g, "' . \"\\x04\" . '");
    const phpValue = escapedValue.replace(/\x00/g, "' . \"\\x00\" . '");
    php += `\t\t'${phpKey}' => '${phpValue}',\n`;
  }

  php += `\t),\n);\n`;
  return php;
}

function processPoFile(poFile) {
  const content = fs.readFileSync(poFile);
  const po = gettextParser.po.parse(content);
  const dir = path.dirname(poFile);
  const basename = path.basename(poFile, '.po');

  // Generate .mo
  const moFile = path.join(dir, `${basename}.mo`);
  const moBuffer = gettextParser.mo.compile(po);
  fs.writeFileSync(moFile, moBuffer);

  // Generate .l10n.php
  const l10nFile = path.join(dir, `${basename}.l10n.php`);
  const l10nContent = generateL10nPhp(po);
  fs.writeFileSync(l10nFile, l10nContent);

  // Count translated strings
  let translated = 0;
  for (const [, entries] of Object.entries(po.translations)) {
    for (const [msgid, entry] of Object.entries(entries)) {
      if (msgid && entry.msgstr && entry.msgstr[0]) translated++;
    }
  }

  console.log(`  ${basename}: ${translated} strings → .mo + .l10n.php`);
}

function main() {
  const locale = process.argv[2];

  let pattern;
  if (locale) {
    pattern = path.join(TRANSLATIONS_PHP_DIR, locale, '*.po');
    console.log(`Generating .mo and .l10n.php for locale: ${locale}\n`);
  } else {
    pattern = path.join(TRANSLATIONS_PHP_DIR, '**', '*.po');
    console.log('Generating .mo and .l10n.php for all locales\n');
  }

  const poFiles = globSync(pattern);

  if (poFiles.length === 0) {
    console.log('No .po files found. Run translate first.');
    return;
  }

  for (const poFile of poFiles) {
    processPoFile(poFile);
  }

  console.log(`\nProcessed ${poFiles.length} file(s).`);
}

main();
