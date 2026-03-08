#!/usr/bin/env node
/**
 * StringTable Binary Builder
 * 
 * Produces binary files compatible with the C++ StringTable reader.
 * 
 * Binary format (all values big-endian, Java DataInputStream style):
 * 
 * OUTER FILE:
 *   INT32    versionNumber
 *   INT32    languagesCount
 *   for each language:
 *     UTF     langId          (UINT16 length prefix + UTF-8 bytes)
 *     INT32   langSize        (byte size of this language's blob)
 *   for each language (in same order):
 *     BYTES   langBlob        (see LANGUAGE BLOB format below)
 *
 * LANGUAGE BLOB:
 *   INT32    langVersion
 *   BOOLEAN  isStatic        (only present if langVersion > 0)
 *   UTF      langId
 *   INT32    totalStrings
 *   if !isStatic (map mode — keyed by wstring id):
 *     for each string:
 *       UTF  stringId
 *       UTF  stringValue
 *   if isStatic (vec mode — keyed by integer index):
 *     for each string:
 *       UTF  stringValue
 *
 * UTF encoding: 2-byte big-endian length (in bytes) followed by CESU-8 / Java
 * modified UTF-8. For BMP characters this is identical to standard UTF-8.
 * Supplementary characters are encoded as surrogate pairs (2×3 bytes each).
 */

const fs   = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

// ---------------------------------------------------------------------------
// Buffer helpers (big-endian, Java DataOutputStream compatible)
// ---------------------------------------------------------------------------

function writeInt(buf, offset, value) {
  buf.writeInt32BE(value, offset);
  return offset + 4;
}

function writeBoolean(buf, offset, value) {
  buf.writeUInt8(value ? 1 : 0, offset);
  return offset + 1;
}

/**
 * Encode a JS string as Java "modified UTF-8" (CESU-8 for supplementary chars).
 * Returns a Buffer of the encoded bytes (NOT including the 2-byte length prefix).
 */
function javaUTFBytes(str) {
  const parts = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x0000) {
      // Null char → 2-byte form 0xC0 0x80
      parts.push(Buffer.from([0xC0, 0x80]));
    } else if (code <= 0x007F) {
      parts.push(Buffer.from([code]));
    } else if (code <= 0x07FF) {
      parts.push(Buffer.from([
        0xC0 | (code >> 6),
        0x80 | (code & 0x3F)
      ]));
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate — encode pair as two 3-byte sequences (CESU-8)
      const hi = code;
      const lo = str.charCodeAt(++i);
      parts.push(Buffer.from([
        0xE0 | (hi >> 12),        0x80 | ((hi >> 6) & 0x3F),  0x80 | (hi & 0x3F),
        0xE0 | (lo >> 12),        0x80 | ((lo >> 6) & 0x3F),  0x80 | (lo & 0x3F)
      ]));
    } else {
      parts.push(Buffer.from([
        0xE0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F)
      ]));
    }
  }
  return Buffer.concat(parts);
}

/**
 * Write a Java UTF string: UINT16 length (bytes) + encoded bytes.
 * Returns a Buffer.
 */
function writeUTF(str) {
  const encoded = javaUTFBytes(str);
  if (encoded.length > 65535) throw new Error(`String too long for UTF encoding: ${str.substring(0,40)}...`);
  const out = Buffer.allocUnsafe(2 + encoded.length);
  out.writeUInt16BE(encoded.length, 0);
  encoded.copy(out, 2);
  return out;
}

// ---------------------------------------------------------------------------
// Language blob builder
// ---------------------------------------------------------------------------

/**
 * Build one language blob in static/vec mode.
 * Strings are written in Object.keys() insertion order of the base language.
 * For non-base languages, keys not present are written as empty string.
 *
 * Returns { buf, keyOrder } where keyOrder is the actual write sequence —
 * only meaningful for the base language (all others follow the same order).
 *
 * @param {string}      langId
 * @param {object}      strings      { key: value, ... }
 * @param {string[]|null} keyOrder   Pass null for base lang (derives order from
 *                                   Object.keys). Pass the base keyOrder for all
 *                                   other languages so they share the same layout.
 * @param {number}      langVersion
 * @returns {{ buf: Buffer, keyOrder: string[] }}
 */
function buildLanguageBlob(langId, strings, keyOrder = null, langVersion = 1) {
  // Base language: derive order from insertion order of its own keys.
  // Other languages: use the base order so every vec index matches.
  const order = keyOrder ?? Object.keys(strings);

  const parts = [];

  // langVersion (INT32)
  const vBuf = Buffer.allocUnsafe(4);
  vBuf.writeInt32BE(langVersion, 0);
  parts.push(vBuf);

  // isStatic = true (BOOLEAN, only if langVersion > 0)
  if (langVersion > 0) {
    parts.push(Buffer.from([1]));
  }

  // langId (UTF)
  parts.push(writeUTF(langId));

  // totalStrings (INT32)
  const countBuf = Buffer.allocUnsafe(4);
  countBuf.writeInt32BE(order.length, 0);
  parts.push(countBuf);

  // Write values in order — missing keys in non-base languages = empty string
  let missing = 0;
  for (const key of order) {
    const value = strings[key];
    if (value === undefined) missing++;
    parts.push(writeUTF(value !== undefined ? String(value) : ''));
  }

  if (missing > 0) {
    process.stderr.write(
      `  Warning [${langId}]: ${missing} key(s) missing, written as empty string.\n`
    );
  }

  return { buf: Buffer.concat(parts), keyOrder: order };
}

// ---------------------------------------------------------------------------
// Top-level file builder
// ---------------------------------------------------------------------------

/**
 * Build the complete StringTable binary file.
 *
 * @param {Array}       languages   Array of { langId, strings, langVersion? }
 * @param {number}      fileVersion The outer versionNumber field (default 1)
/**
 * Build the complete StringTable binary file.
 * The base (first) language determines the key insertion order.
 * All other languages are written in that same order.
 *
 * @param {Array}   languages    Array of { langId, strings, langVersion? }
 * @param {number}  fileVersion
 * @returns {{ buf: Buffer, keyOrder: string[] }}
 */
function buildStringTableFile(languages, fileVersion = 1) {
  // Build base language first to establish keyOrder from insertion order
  const baseBlob = buildLanguageBlob(
    languages[0].langId,
    languages[0].strings,
    null,
    languages[0].langVersion ?? 1
  );
  const keyOrder = baseBlob.keyOrder;

  // Build remaining languages using the same keyOrder
  const blobs = [
    baseBlob.buf,
    ...languages.slice(1).map(({ langId, strings, langVersion }) =>
      buildLanguageBlob(langId, strings, keyOrder, langVersion ?? 1).buf
    )
  ];

  const parts = [];

  // versionNumber (INT32)
  const fvBuf = Buffer.allocUnsafe(4);
  fvBuf.writeInt32BE(fileVersion, 0);
  parts.push(fvBuf);

  // languagesCount (INT32)
  const lcBuf = Buffer.allocUnsafe(4);
  lcBuf.writeInt32BE(languages.length, 0);
  parts.push(lcBuf);

  // Directory: langId + blob size for each language
  for (let i = 0; i < languages.length; i++) {
    parts.push(writeUTF(languages[i].langId));
    const szBuf = Buffer.allocUnsafe(4);
    szBuf.writeInt32BE(blobs[i].length, 0);
    parts.push(szBuf);
  }

  // Language data blobs in same order
  for (const blob of blobs) {
    parts.push(blob);
  }

  return { buf: Buffer.concat(parts), keyOrder };
}

// ---------------------------------------------------------------------------
// XML parser  (matches the example <root><data name="..."><value>...</value>)
// ---------------------------------------------------------------------------

function parseXmlStrings(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  const result = {};
  const dataNodes = doc.getElementsByTagName('data');
  for (let i = 0; i < dataNodes.length; i++) {
    const node = dataNodes[i];
    const name = node.getAttribute('name');
    const valueNodes = node.getElementsByTagName('value');
    if (name && valueNodes.length > 0) {
      result[name] = valueNodes[0].textContent || '';
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
StringTable Binary Builder
==========================
Usage:
  node index.js build <output.bin> <lang1:input1.xml> [lang2:input2.xml ...]
  node index.js build <output.bin> --folder <dir>
  node index.js example

Individual XML mode:
  Specify each language explicitly as  langId:path/to/file.xml
  Example:
    node index.js build strings.bin en-US:english.xml fr-FR:french.xml

Folder mode:
  Point at a root directory structured like:
    locales/          <- root XMLs = base language (en-US by default)
      a.xml
      b.xml
    locales/es-ES/    <- subfolder name = langId
      a.xml
      b.xml
    locales/fr-FR/
      a.xml
      b.xml

  All XML files within each folder are merged into one language blob.
  Command:
    node index.js build strings.bin --folder locales/
    node index.js build strings.bin --folder locales/ --base-lang en-GB
`);
}

// ---------------------------------------------------------------------------
// Folder loader
// ---------------------------------------------------------------------------

/**
 * Load all languages from a root folder with the structure:
 *
 *   <root>/          ← base language (en-US by default)
 *     a.xml
 *     b.xml
 *   <root>/es-ES/    ← subfolder name = langId
 *     a.xml
 *     b.xml
 *
 * All XML files within a language folder are merged into a single strings map.
 * Files are processed in alphabetical order. Duplicate keys: last file wins.
 *
 * @param {string} rootDir      Path to the root directory
 * @param {string} baseLangId   langId to assign to the root XML files (default 'en-US')
 * @returns {{ langId: string, strings: object }[]}
 */
function loadLanguagesFromFolder(rootDir, baseLangId = 'en-EN') {
  if (!fs.existsSync(rootDir)) {
    console.error(`Folder not found: ${rootDir}`);
    process.exit(1);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }

  /**
   * Merge all *.xml files in a directory into one strings object.
   * Returns null if no XML files exist.
   */
  function mergeXmlsInDir(dir) {
    const xmlFiles = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith('.xml'))
      .sort();
    if (xmlFiles.length === 0) return null;

    const merged = {};
    for (const filename of xmlFiles) {
      const xmlFile = path.join(dir, filename);
      const strings = parseXmlStrings(fs.readFileSync(xmlFile, 'utf8'));
      Object.assign(merged, strings);
    }
    return { merged, count: Object.keys(merged).length, fileCount: xmlFiles.length };
  }

  const languages = [];

  // 1. Root dir = base language
  const baseResult = mergeXmlsInDir(rootDir);
  if (baseResult) {
    console.log(`  ${baseLangId.padEnd(20)}: ${baseResult.count} strings from ${baseResult.fileCount} file(s) in ${rootDir}`);
    languages.push({ langId: baseLangId, strings: baseResult.merged });
  } else {
    console.warn(`  Warning: no XML files found in root dir (${rootDir}), skipping base language.`);
  }

  // 2. Each immediate subdirectory = another language
  const subdirs = fs.readdirSync(rootDir)
    .filter(entry => {
      const full = path.join(rootDir, entry);
      return fs.statSync(full).isDirectory();
    })
    .sort();

  for (const subdir of subdirs) {
    const langId  = subdir;                          // folder name IS the langId (e.g. "es-ES")
    const fullDir = path.join(rootDir, subdir);
    const result  = mergeXmlsInDir(fullDir);
    if (!result) {
      console.warn(`  Warning: no XML files in ${fullDir}, skipping.`);
      continue;
    }
    console.log(`  ${langId.padEnd(20)}: ${result.count} strings from ${result.fileCount} file(s) in ${fullDir}`);
    languages.push({ langId, strings: result.merged });
  }

  if (languages.length === 0) {
    console.error('No languages found — make sure the root folder contains XML files and/or language subfolders.');
    process.exit(1);
  }

  return languages;
}

// ---------------------------------------------------------------------------
// strings.h generator
// ---------------------------------------------------------------------------

/**
 * Generate a strings.h header that reflects the actual index each key was
 * written at in the binary blob. keyOrder is the array of keys in the exact
 * order they were written — index 0 = first written, index 1 = second, etc.
 *
 * @param {string}   baseLangId  e.g. "en-US"
 * @param {string[]} keyOrder    Keys in the exact order written to the binary
 * @returns {string}  Contents of strings.h
 */
function generateStringsH(baseLangId, keyOrder) {
  const lines = [
    '#pragma once',
    `// Auto-generated by StringTable builder — do not edit manually.`,
    `// Source language: ${baseLangId}`,
    `// Total strings:   ${keyOrder.length}`,
    '',
  ];

  const maxLen = keyOrder.reduce((m, k) => Math.max(m, k.length), 0);

  keyOrder.forEach((key, idx) => {
    lines.push(`#define ${key.padEnd(maxLen)}  ${idx}`);
  });

  lines.push('');
  return lines.join('\n');
}

function runExample() {
  // Build a small example with two languages
  const enStrings = {
    IDS_NOFREESPACE_TEXT: "Your system storage doesn't have enough free space to create a game save.",
    IDS_OK:    'OK',
    IDS_CANCEL:'Cancel',
  };
  const frStrings = {
    IDS_NOFREESPACE_TEXT: "Votre stockage système n'a pas assez d'espace libre pour créer une sauvegarde.",
    IDS_OK:    'OK',
    IDS_CANCEL:'Annuler',
  };

  const languages = [
    { langId: 'en-US', strings: enStrings },
    { langId: 'fr-FR', strings: frStrings },
  ];

  const buf = buildStringTableFile(languages);
  const outFile = 'example_strings.bin';
  fs.writeFileSync(outFile, buf);
  console.log(`Written ${buf.length} bytes to ${outFile}`);
  console.log(`Languages: ${languages.map(l => l.langId).join(', ')}`);
  console.log(`Strings per language: ${Object.keys(enStrings).length}`);
}

function runBuild(args) {
  if (args.length < 2) { printUsage(); process.exit(1); }
  const outFile = args[0];
  const rest    = args.slice(1);

  let languages;

  // --folder <dir> [--base-lang <langId>]  mode
  const folderIdx = rest.indexOf('--folder');
  if (folderIdx !== -1) {
    const dir = rest[folderIdx + 1];
    if (!dir) {
      console.error('--folder requires a directory path');
      process.exit(1);
    }
    const baseLangIdx = rest.indexOf('--base-lang');
    const baseLang    = baseLangIdx !== -1 ? rest[baseLangIdx + 1] : 'en-US';
    console.log(`Loading languages from folder: ${dir}  (base language: ${baseLang})`);
    languages = loadLanguagesFromFolder(dir, baseLang);
  } else {
    // Individual  lang:file.xml  mode
    languages = rest.map(arg => {
      const colonIdx = arg.indexOf(':');
      if (colonIdx === -1) {
        console.error(`Invalid language argument (expected lang:file.xml or --folder <dir>): ${arg}`);
        process.exit(1);
      }
      const langId  = arg.substring(0, colonIdx);
      const xmlFile = arg.substring(colonIdx + 1);
      const xmlStr  = fs.readFileSync(xmlFile, 'utf8');
      const strings = parseXmlStrings(xmlStr);
      console.log(`  ${langId.padEnd(20)}: ${Object.keys(strings).length} strings  <- ${xmlFile}`);
      return { langId, strings };
    });
  }

  // Generate binary — keyOrder comes back as the actual write sequence
  const { buf, keyOrder } = buildStringTableFile(languages);
  fs.writeFileSync(outFile, buf);
  console.log(`\nWritten ${buf.length} bytes to ${outFile}  (${languages.length} language(s))`);

  // Write strings.h reflecting the exact index each key was written at
  const stringsHPath = 'strings.h';
  const header = generateStringsH(languages[0].langId, keyOrder);
  fs.writeFileSync(stringsHPath, header, 'utf8');
  console.log(`Written ${keyOrder.length} #define(s) to ${stringsHPath}`);
}

// ---------------------------------------------------------------------------

const [,, cmd, ...rest] = process.argv;
switch (cmd) {
  case 'build':   runBuild(rest);  break;
  case 'example': runExample();    break;
  default:        printUsage();    break;
}