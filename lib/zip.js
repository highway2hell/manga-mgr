'use strict';

/**
 * Minimal ZIP reader (central-directory based).
 *
 * Used instead of spawning an external tool for single-entry reads: it seeks
 * straight to the wanted entry instead of streaming the whole archive, and it
 * keeps entry names consistent between listing and extraction (no shell
 * globbing, no encoding surprises).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const util = require('./util');

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function decodeName(buf, utf8Flag) {
  if (utf8Flag) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      /* fall through */
    }
  } else {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      try {
        return new TextDecoder('gbk').decode(buf);
      } catch {
        /* fall through */
      }
    }
  }
  return buf.toString('latin1');
}

async function readAt(filePath, position, length) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Central directory of a ZIP file, as `{ entries }`. */
async function readDirectory(filePath) {
  const { size } = await fs.promises.stat(filePath);
  const tailLen = Math.min(size, 66560);
  const tail = await readAt(filePath, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)');

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate, the real values live in the ZIP64 EOCD.
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const locOffset = eocd - 20;
    if (locOffset >= 0 && tail.readUInt32LE(locOffset) === EOCD64_LOC_SIG) {
      const eocd64Offset = Number(tail.readBigUInt64LE(locOffset + 8));
      const rec = await readAt(filePath, eocd64Offset, 56);
      if (rec.readUInt32LE(0) === EOCD64_SIG) {
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }
  }

  const cd = await readAt(filePath, cdOffset, Math.min(cdSize, 512 * 1024 * 1024));
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && entries.length < count + 16) {
    if (cd.readUInt32LE(p) !== CD_SIG) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    entries.push({ name, method, compSize, uncompSize, localOffset, flags, zip64: compSize === 0xffffffff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

/** Entry names in central-directory order. */
async function listEntries(filePath) {
  const { entries } = await readDirectory(filePath);
  return entries.map((e) => e.name);
}

async function entryMap(filePath) {
  const { entries } = await readDirectory(filePath);
  const map = new Map();
  for (const e of entries) map.set(e.name, e);
  return map;
}

/** Extract one entry (by exact name) to `outFile`. */
async function extractEntryTo(filePath, entryName, outFile) {
  const map = await entryMap(filePath);
  const entry = map.get(entryName);
  if (!entry) throw new Error('entry not found in zip: ' + entryName);
  if (entry.zip64) throw new Error('zip64 entry not supported here: ' + entryName);

  const head = await readAt(filePath, entry.localOffset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== LOCAL_SIG) throw new Error('bad local header for ' + entryName);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;

  const source = fs.createReadStream(filePath, { start: dataStart, end: dataStart + entry.compSize - 1 });
  const dest = fs.createWriteStream(outFile);
  if (entry.method === 0) {
    await pipeline(source, dest);
  } else if (entry.method === 8) {
    await pipeline(source, zlib.createInflateRaw(), dest);
  } else {
    throw new Error('unsupported zip compression method ' + entry.method + ' for ' + entryName);
  }
  return outFile;
}

/** Extract every entry into `destDir` (directories created as needed). */
async function extractAll(filePath, destDir) {
  const { entries } = await readDirectory(filePath);
  let count = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) continue;
    const target = path.resolve(destDir, entry.name);
    if (!util.isInside(destDir, target)) continue; // zip-slip guard
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.zip64) throw new Error('zip64 entry not supported: ' + entry.name);
    await extractEntryTo(filePath, entry.name, target);
    count++;
  }
  return count;
}

/** Read one entry into memory (small files only). */
async function readEntry(filePath, entryName) {
  const { entry, data } = await readEntryBuffer(filePath, entryName);
  return { entry, data };
}

async function readEntryBuffer(filePath, entryName) {
  const map = await entryMap(filePath);
  const entry = map.get(entryName);
  if (!entry) throw new Error('entry not found in zip: ' + entryName);
  const head = await readAt(filePath, entry.localOffset, 30);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = await readAt(filePath, dataStart, entry.compSize);
  const data = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
  return { entry, data };
}

module.exports = { listEntries, entryMap, extractEntryTo, extractAll, readEntry, readEntryBuffer, readDirectory };
