#!/usr/bin/env node

/**
 * Extract translatable strings from WCPOS WordPress plugins.
 *
 * Uses wp-pot to generate .pot files for each plugin.
 * Handles the free/pro plugin relationship by excluding vendor/ from pro.
 *
 * Usage:
 *   node scripts/extract-php-strings.js [--free path] [--pro path]
 *
 * Defaults to sibling directories ../woocommerce-pos and ../woocommerce-pos-pro
 */

const wpPot = require('wp-pot');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const FREE_PATH = getArg('free', path.resolve(__dirname, '../../woocommerce-pos'));
const PRO_PATH = getArg('pro', path.resolve(__dirname, '../../woocommerce-pos-pro'));
const OUTPUT_DIR = path.resolve(__dirname, '../source/php');

const plugins = [
  {
    name: 'WooCommerce POS',
    domain: 'woocommerce-pos',
    src: FREE_PATH,
    exclude: ['vendor/**', 'node_modules/**', 'tests/**'],
  },
  {
    name: 'WooCommerce POS Pro',
    domain: 'woocommerce-pos-pro',
    src: PRO_PATH,
    // Exclude vendor/ to avoid duplicating free plugin strings
    exclude: ['vendor/**', 'node_modules/**', 'tests/**'],
  },
];

function extractPlugin(plugin) {
  const srcDir = plugin.src;

  if (!fs.existsSync(srcDir)) {
    console.warn(`Warning: ${plugin.name} not found at ${srcDir}, skipping`);
    return null;
  }

  const outputFile = path.join(OUTPUT_DIR, `${plugin.domain}.pot`);

  console.log(`Extracting: ${plugin.name}`);
  console.log(`  Source: ${srcDir}`);
  console.log(`  Output: ${outputFile}`);
  console.log(`  Excluding: ${plugin.exclude.join(', ')}`);

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  wpPot({
    destFile: outputFile,
    domain: plugin.domain,
    package: plugin.name,
    src: path.join(srcDir, '**/*.php'),
    writeFile: true,
    headers: {
      'Report-Msgid-Bugs-To': 'https://github.com/wcpos/translations/issues',
      'Language-Team': 'WCPOS <support@wcpos.com>',
    },
    // wp-pot uses globbing, so we pass exclude patterns relative to src
    globOpts: {
      ignore: plugin.exclude.map(p => path.join(srcDir, p)),
    },
  });

  // Count strings in generated POT
  if (fs.existsSync(outputFile)) {
    const content = fs.readFileSync(outputFile, 'utf8');
    const msgidCount = (content.match(/^msgid "/gm) || []).length - 1; // -1 for header
    console.log(`  Extracted ${msgidCount} strings\n`);
    return msgidCount;
  }

  console.warn(`  Warning: POT file was not created\n`);
  return 0;
}

function main() {
  console.log('Extracting PHP translation strings\n');

  let totalStrings = 0;

  for (const plugin of plugins) {
    const count = extractPlugin(plugin);
    if (count !== null) {
      totalStrings += count;
    }
  }

  console.log(`Total: ${totalStrings} strings across ${plugins.length} plugins`);
  console.log('Done.');
}

main();
