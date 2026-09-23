#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  getPhpPluralForms,
  ensurePoHeader,
  parsePoFile,
  serializePoFile,
  buildPoEntryKey,
  hasPoEntryTranslation,
  mergePoEntries,
  generateL10nPhp,
  parsePluralSlotCount,
} = require('../scripts/po-file');

assert.equal(getPhpPluralForms('ar').nplurals, 6);
assert.equal(getPhpPluralForms('ja').nplurals, 1);
assert.equal(getPhpPluralForms('fr_FR').expression, 'n > 1');
assert.equal(getPhpPluralForms('de_DE').expression, 'n != 1');
assert.equal(getPhpPluralForms('ar').header,
  `nplurals=6; plural=${getPhpPluralForms('ar').expression};`);
assert.equal(parsePluralSlotCount('Plural-Forms: nplurals=6; plural=n;'), 6);
assert.equal(parsePluralSlotCount('plural-forms: nplurals = 2;'), 2);
for (const header of ['', 'Language: ja', 'Plural-Forms: nplurals=0;',
  'Plural-Forms: nplurals=-1;', 'Plural-Forms: nplurals=invalid;']) {
  assert.equal(parsePluralSlotCount(header), undefined);
}
const updatedHeader = ensurePoHeader('Language: en\nPlural-Forms: nplurals=2;\nX-Test: kept\n', 'domain', 'ja');
assert.equal(updatedHeader, 'Language: ja\nPlural-Forms: nplurals=1; plural=0;\nX-Test: kept');
assert.ok(ensurePoHeader('', 'domain', 'ar').includes('Project-Id-Version: domain\n'));
assert.equal(buildPoEntryKey(undefined, 'Sale'), '\u0004Sale');
assert.equal(buildPoEntryKey('noun', 'Sale'), 'noun\u0004Sale');

const potEntries = [
  { comments: ['#: new.php:1'], msgid: 'Sale', msgstr: '', flags: [] },
  { comments: [], msgid: 'New', msgstr: '', flags: [] },
  { comments: [], msgid: 'Item', msgid_plural: 'Items', msgstr: '', msgstr_plural: ['', ''], flags: [] },
];
const existingEntries = [
  { comments: [], msgid: 'Sale', msgstr: 'Verkauf', flags: [] },
  { comments: [], msgid: 'Obsolete', msgstr: 'Alt', flags: [] },
  { comments: [], msgid: 'Item', msgid_plural: 'Items', msgstr: 'Artikel', msgstr_plural: ['Artikel'], flags: [] },
];
const result = mergePoEntries(potEntries, existingEntries, 2);
assert.deepEqual(result.mergedEntries, [
  { ...potEntries[0], msgstr: 'Verkauf', msgstr_plural: undefined },
  potEntries[1],
  potEntries[2],
]);
assert.deepEqual(result.untranslated, [
  { index: 1, entry: potEntries[1] },
  { index: 2, entry: potEntries[2] },
]);
assert.equal(result.skipped, 1);
assert.equal(hasPoEntryTranslation(existingEntries[2], 2), false);
const completePlural = { ...existingEntries[2], msgstr_plural: ['Artikel', 'Artikel'] };
assert.equal(hasPoEntryTranslation(completePlural, 2), true);
assert.equal(hasPoEntryTranslation({ ...completePlural, msgstr_plural: ['Artikel', ' '] }, 2), false);
const keptPlural = mergePoEntries([potEntries[2]], [completePlural], 2).mergedEntries[0];
assert.deepEqual(keptPlural.msgstr_plural, completePlural.msgstr_plural);
assert.notEqual(keptPlural.msgstr_plural, completePlural.msgstr_plural);

const parsed = parsePoFile('msgid "Sale"\nmsgstr "Verkauf"\n');
assert.deepEqual(parsed.entries[0], {
  comments: [], msgctxt: undefined, msgid: 'Sale', msgid_plural: undefined,
  msgstr: 'Verkauf', msgstr_plural: undefined, flags: [],
});
const emptyOptionals = { ...parsed.entries[0], msgctxt: '', msgid_plural: '' };
const serialized = serializePoFile('', [emptyOptionals]);
assert.ok(serialized.includes('msgctxt ""\n'));
assert.ok(serialized.includes('msgid_plural ""\n'));
const escapedEntry = {
  comments: ['#, fuzzy, php-format'], msgctxt: 'label', msgid: 'Quote "\t\\\n',
  msgid_plural: 'Quotes', msgstr: "L'article\\", msgstr_plural: ["L'article\\", 'Articles\n'],
  flags: ['fuzzy', 'php-format'],
};
assert.deepEqual(parsePoFile(serializePoFile('', [escapedEntry])).entries, [escapedEntry]);
assert.equal(generateL10nPhp([escapedEntry], 'Language: fr_FR\n'),
  '<?php\nreturn array(\n' +
  "\t'language' => 'fr_FR',\n\t'messages' => array(\n" +
  "\t\t'label' . \"\\x04\" . 'Quote \"\t\\\\\n' => 'L\\'article\\\\' . \"\\x00\" . 'Articles\n',\n" +
  '\t),\n);\n');

const root = path.join(__dirname, '../translations/php');
const excludedLocales = new Set(['en', 'en_US', 'en_GB']);
let fileCount = 0;
for (const locale of fs.readdirSync(root, { withFileTypes: true })) {
  if (!locale.isDirectory() || excludedLocales.has(locale.name)) continue;
  const directory = path.join(root, locale.name);
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.po'))) {
    const filename = path.join(directory, file);
    const content = fs.readFileSync(filename);
    const { header, entries } = parsePoFile(content.toString('utf8'));
    assert.ok(Buffer.from(serializePoFile(header, entries)).equals(content), `${filename}: PO round-trip differs`);
    const phpFilename = filename.replace(/\.po$/, '.l10n.php');
    assert.ok(Buffer.from(generateL10nPhp(entries, header)).equals(fs.readFileSync(phpFilename)),
      `${phpFilename}: PHP output differs`);
    fileCount++;
  }
}
assert.ok(fileCount > 0, 'Expected non-English PO files');
console.log(`PASS: ${fileCount} PO/PHP file pairs round-trip byte for byte; unit cases passed.`);
