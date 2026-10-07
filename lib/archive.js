'use strict';

/**
 * Archive access (zip / cbz / epub / rar / cbr / 7z).
 *
 * - ZIP family: handled by the built-in reader, so no external tool is needed.
 * - RAR / 7z: whichever helper is available is used, preferring bsdtar (macOS,
 *   many Linux boxes) and falling back to a 7-Zip binary — including one shipped
 *   in ./bin, which is how this runs on servers where nothing can be installed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const zip = require('./zip');
const util = require('./util');
const tools = require('./tools');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif', '.tif', '.tiff']);

function isImageEntry(name) {
  const base = path.basename(name);
  if (base.startsWith('._') || base === '.DS_Store' || name.startsWith('__MACOSX/')) return false;
  return IMAGE_EXTS.has(path.extname(base).toLowerCase());
}

const ZIP_EXTS = new Set(['.zip', '.cbz', '.epub', '.jar']);

function isZipFile(filePath) {
  return ZIP_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Which tool can read RAR/7z right now. */
function backend() {
  const t = tools.detect();
  if (t.bsdtar) return { kind: 'bsdtar', bin: t.bsdtar };
  if (t.sevenZip) return { kind: '7z', bin: t.sevenZip };
  if (t.unar) return { kind: 'unar', bin: t.unar, lsar: t.lsar };
  if (t.unrar) return { kind: 'unrar', bin: t.unrar };
  return null;
}

function noBackendError() {
  return new Error('no RAR/7z reader available — install libarchive-tools or p7zip-full, or drop a 7-Zip binary at bin/7zz');
}

/** Parse `7z l -ba -slt` output into entry names (files only). */
function parse7zListing(stdout, archivePath) {
  const items = [];
  let current = null;
  for (const raw of String(stdout).split(/\r?\n/)) {
    if (raw.startsWith('Path = ')) {
      if (current) items.push(current);
      current = { path: raw.slice(7), folder: false };
    } else if (raw.startsWith('Folder = ') && current) {
      current.folder = raw.slice(9).trim() === '+';
    }
  }
  if (current) items.push(current);
  return items
    .filter((it) => it.path && it.path !== archivePath)
    .filter((it) => !it.folder)
    .map((it) => it.path);
}

/** Entry names inside an archive, in archive order. */
async function listEntries(archivePath) {
  if (isZipFile(archivePath)) {
    try {
      return await zip.listEntries(archivePath);
    } catch {
      /* exotic zip: fall through to the external tool */
    }
  }
  const b = backend();
  if (!b) throw noBackendError();

  if (b.kind === 'bsdtar') {
    const { stdout } = await tools.run(b.bin, ['-tf', archivePath], 120000);
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  if (b.kind === '7z') {
    const { stdout } = await tools.run(b.bin, ['l', '-ba', '-slt', '--', archivePath], 180000);
    return parse7zListing(stdout, archivePath);
  }
  if (b.kind === 'unar') {
    if (!b.lsar) throw noBackendError();
    const { stdout } = await tools.run(b.lsar, [archivePath], 180000);
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith('/') && !/^(\d|Archive|Volume|Total|─|═)/.test(l));
  }
  const { stdout } = await tools.run(b.bin, ['lb', archivePath], 180000);
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Image entries only, for cover generation. */
async function listImageEntries(archivePath) {
  const entries = await listEntries(archivePath);
  return entries.filter(isImageEntry);
}

// bsdtar treats its arguments as fnmatch patterns, so entry names containing
// `[`, `]`, `*` or `?` (common in release-style names) must be made literal
// first. `?` matches exactly one character, so substituting it for every
// metacharacter keeps the pattern anchored to the original name.
function escapePattern(entry) {
  return /[*?[\]\\]/.test(entry) ? entry.replace(/[*?[\]\\]/g, '?') : entry;
}

/** Does `name` match a pattern produced by escapePattern? */
function looseMatch(name, pattern) {
  if (name.length !== pattern.length) return false;
  for (let i = 0; i < name.length; i++) {
    if (pattern[i] !== '?' && pattern[i] !== name[i]) return false;
  }
  return true;
}

/** True when the escaped pattern cannot identify exactly one entry. */
function isAmbiguous(entry, allEntries) {
  const pattern = escapePattern(entry);
  if (pattern === entry) return false;
  let seen = 0;
  for (const name of allEntries) {
    if (looseMatch(name, pattern)) {
      seen++;
      if (seen > 1) return true;
    }
  }
  return seen !== 1;
}

/** Pipe a child process's stdout into `outFile`. */
function pipeToFile(bin, args, outFile) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    // spawn (not execFile): pages are far larger than the default buffer cap.
    const child = spawn(bin, args);
    let stderr = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(err);
    };
    // The output stream must have an error handler from the start: an
    // unhandled 'error' event would take the whole server down.
    out.on('error', fail);
    child.stderr.on('data', (d) => {
      stderr += d.toString().slice(0, 500);
    });
    child.stdout.pipe(out);
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(path.basename(bin) + ' exited with ' + code + (stderr ? ': ' + stderr.trim() : '')));
        return;
      }
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve(outFile);
      });
    });
  });
}

/** `unar` writes into a directory, so extract to a temp dir and pick the file. */
async function extractWithUnar(unar, lsar, archivePath, entry, outFile) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mangamgr-un-'));
  try {
    await tools.run(unar, ['-q', '-o', tmp, '-f', archivePath, entry], 180000);
    const found = await findByName(tmp, entry);
    if (!found) throw new Error('unar did not produce ' + entry);
    await fs.promises.copyFile(found, outFile);
    return outFile;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

async function findByName(root, entry) {
  const target = path.basename(entry);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === target) return full;
    }
  }
  return null;
}

/** Extract one entry into `outFile`. */
async function extractEntryTo(archivePath, entry, outFile, allEntries) {
  if (isZipFile(archivePath)) {
    try {
      return await zip.extractEntryTo(archivePath, entry, outFile);
    } catch (err) {
      if (allEntries == null) throw err;
      /* fall back to the external tool for exotic zips */
    }
  }
  const b = backend();
  if (!b) throw noBackendError();

  if (b.kind === 'bsdtar') {
    if (allEntries && isAmbiguous(entry, allEntries)) {
      throw new Error('ambiguous entry pattern: ' + entry);
    }
    return pipeToFile(b.bin, ['-xOf', archivePath, '--', escapePattern(entry)], outFile);
  }
  if (b.kind === '7z') {
    // 7-Zip treats [ ] as literals, so the exact name is unambiguous.
    return pipeToFile(b.bin, ['x', '-so', '-y', '--', archivePath, entry], outFile);
  }
  if (b.kind === 'unar') {
    return extractWithUnar(b.bin, b.lsar, archivePath, entry, outFile);
  }
  return pipeToFile(b.bin, ['p', '-inul', '--', archivePath, entry], outFile);
}

/** Extract the whole archive into `destDir` (created by the caller). */
async function extractAll(archivePath, destDir) {
  if (isZipFile(archivePath)) {
    try {
      return await zip.extractAll(archivePath, destDir);
    } catch {
      /* fall back to the external tool */
    }
  }
  const b = backend();
  if (!b) throw noBackendError();

  if (b.kind === 'bsdtar') await tools.run(b.bin, ['-xf', archivePath, '-C', destDir], 600000);
  else if (b.kind === '7z') await tools.run(b.bin, ['x', '-y', '-bd', '-o' + destDir, '--', archivePath], 900000);
  else if (b.kind === 'unar') await tools.run(b.bin, ['-q', '-f', '-o', destDir, archivePath], 900000);
  else await tools.run(b.bin, ['x', '-inul', '-o+', archivePath, destDir + path.sep], 900000);
  return destDir;
}

/**
 * Find every image file below `dir`, as paths relative to `dir`,
 * natural-sorted (page order).
 */
async function findImages(dir) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (util.isInside(dir, full)) await walk(full);
      } else if (e.isFile() && isImageEntry(e.name)) {
        out.push(path.relative(dir, full));
      }
    }
  };
  await walk(dir);
  return out;
}

module.exports = {
  backend,
  isZipFile,
  escapePattern,
  looseMatch,
  isAmbiguous,
  isImageEntry,
  IMAGE_EXTS,
  listEntries,
  listImageEntries,
  extractEntryTo,
  extractAll,
  findImages,
};
