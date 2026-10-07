'use strict';

/**
 * Minimal MOBI / PalmDB reader.
 *
 * The manga files from vol.moe / mox.moe are image-based MOBI books: every
 * page is a whole JPEG stored in its own PDB record. We therefore only need
 * the record index (cheap) plus the image records themselves — no text
 * decompression, no conversion, no external tool.
 */

const fs = require('fs');

const MAGIC = [
  { type: 'jpg', magic: [0xff, 0xd8, 0xff], ends: (buf) => buf.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2 },
  { type: 'png', magic: [0x89, 0x50, 0x4e, 0x47], ends: (buf) => buf.lastIndexOf('IEND') + 8 },
  { type: 'gif', magic: [0x47, 0x49, 0x46, 0x38], ends: (buf) => buf.lastIndexOf(0x3b) + 1 },
  { type: 'webp', magic: [0x52, 0x49, 0x46, 0x46], ends: (buf) => buf.lastIndexOf('WEBP') + 8 },
];

function detectType(buf) {
  if (buf.length < 4) return null;
  for (const m of MAGIC) {
    let ok = true;
    for (let i = 0; i < m.magic.length; i++) {
      if (buf[i] !== m.magic[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return m;
  }
  return null;
}

async function readAt(fh, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fh.read(buf, read, length - read, position + read);
    if (bytesRead <= 0) break;
    read += bytesRead;
  }
  return read === length ? buf : buf.subarray(0, read);
}

/** Record table of a PDB/MOBI file. */
async function readRecords(fh, size) {
  const head = await readAt(fh, 0, 78);
  if (head.length < 78) throw new Error('not a PalmDB file');
  const count = head.readUInt16BE(76);
  if (!count) throw new Error('no PDB records');
  const table = await readAt(fh, 78, count * 8);
  const records = [];
  for (let i = 0; i < count; i++) {
    records.push({ index: i, offset: table.readUInt32BE(i * 8), size: 0 });
  }
  for (let i = 0; i < count; i++) {
    const next = i + 1 < count ? records[i + 1].offset : size;
    records[i].size = next > records[i].offset ? next - records[i].offset : 0;
  }
  return { records };
}

/** EXTH metadata: cover / thumbnail record hints. */
function parseExth(rec0, mobiHeaderLength) {
  const out = { coverOffset: null, thumbOffset: null, firstImageIndex: null };
  if (mobiHeaderLength >= 0x60 && rec0.length >= 16 + 0x60) {
    out.firstImageIndex = rec0.readUInt32BE(16 + 0x5c);
  }
  const start = 16 + mobiHeaderLength;
  if (start + 12 > rec0.length) return out;
  if (rec0.toString('latin1', start, start + 4) !== 'EXTH') return out;
  const recordCount = rec0.readUInt32BE(start + 8);
  let p = start + 12;
  for (let i = 0; i < recordCount && p + 8 <= rec0.length; i++) {
    const type = rec0.readUInt32BE(p);
    const len = rec0.readUInt32BE(p + 4);
    if (len < 8 || p + len > rec0.length) break;
    if (type === 201) out.coverOffset = rec0.readUInt32BE(p + 8);
    else if (type === 202) out.thumbOffset = rec0.readUInt32BE(p + 8);
    p += len;
  }
  return out;
}

/**
 * Embedded images in reading order:
 * `{ pages: [{ record, endRecord, chunks, type, size }], coverIndex }`.
 * Images split over several records are stitched back together.
 */
async function listImages(filePath) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const { records } = await readRecords(fh, size);

    const rec0 = await readAt(fh, records[0].offset, Math.min(records[0].size, 1 << 16));
    let meta = { coverOffset: null, thumbOffset: null, firstImageIndex: null };
    if (rec0.length >= 20 && rec0.toString('latin1', 16, 20) === 'MOBI') {
      meta = parseExth(rec0, rec0.readUInt32BE(20));
    }

    const pages = [];
    const TAIL = 64;

    // Reads a record's head/tail only, so listing a 90 MB book is fast; the
    // full bytes are streamed later, and only for the page being read.
    const recordTail = (rec) => readAt(fh, rec.offset + Math.max(0, rec.size - TAIL), Math.min(TAIL, rec.size));

    let i = 0;
    while (i < records.length) {
      const rec = records[i];
      if (!rec.size) {
        i++;
        continue;
      }
      const head = await readAt(fh, rec.offset, Math.min(12, rec.size));
      const magic = detectType(head);
      if (!magic) {
        i++;
        continue;
      }

      const chunks = [{ offset: rec.offset, size: rec.size }];
      let total = rec.size;
      let endRecord = i;
      let done = magic.ends(await recordTail(rec)) >= 0;

      for (let guard = 0; !done && endRecord + 1 < records.length && guard < 40; guard++) {
        const nextRec = records[endRecord + 1];
        if (!nextRec.size) break;
        const nextHead = await readAt(fh, nextRec.offset, Math.min(12, nextRec.size));
        if (detectType(nextHead)) {
          done = true; // a new image begins: this page ended here
          break;
        }
        endRecord++;
        chunks.push({ offset: nextRec.offset, size: nextRec.size });
        total += nextRec.size;
        done = magic.ends(await recordTail(nextRec)) >= 0;
        if (total > 64 * 1024 * 1024) break;
      }

      pages.push({ record: i, endRecord, type: magic.type, chunks, size: total });
      i = endRecord + 1;
    }

    let coverIndex = pages.length ? 0 : -1;
    if (meta.coverOffset != null && meta.firstImageIndex != null) {
      const wanted = meta.firstImageIndex + meta.coverOffset;
      const found = pages.findIndex((p) => p.record <= wanted && p.endRecord >= wanted);
      if (found >= 0) coverIndex = found;
    }

    return { pages, coverIndex, recordCount: records.length };
  } finally {
    await fh.close();
  }
}

/** Copy one embedded image to `outFile` (only its own byte ranges are read). */
async function writeImage(filePath, page, outFile) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let failure = null;
    const out = fs.createWriteStream(outFile);
    // Resolve (never reject) on error and re-throw where the caller awaits:
    // a rejection raised here would be unhandled for a tick and, depending on
    // timing, would still take the process down.
    const finished = new Promise((resolve) => {
      out.on('error', (err) => {
        failure = err;
        resolve();
      });
      out.on('finish', resolve);
    });
    for (const chunk of page.chunks) {
      let pos = chunk.offset;
      let remaining = chunk.size;
      while (remaining > 0) {
        const len = Math.min(remaining, 4 * 1024 * 1024);
        const buf = await readAt(fh, pos, len);
        if (!buf.length) break;
        if (failure) throw failure;
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
        pos += buf.length;
        remaining -= buf.length;
      }
    }
    if (!failure) out.end();
    await finished;
    if (failure) throw failure;
  } finally {
    await fh.close();
  }
}

module.exports = { listImages, writeImage, detectType };
