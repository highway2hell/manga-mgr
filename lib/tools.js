'use strict';

/**
 * Cross-platform tool detection.
 *
 * The app must run on macOS (sips/qlmanage) and on bare Linux servers without
 * root (Pillow, poppler, a 7-Zip binary shipped in ./bin). Everything optional
 * degrades gracefully: ZIP/CBZ/EPUB are handled by the built-in reader, MOBI and
 * image folders are pure Node, so only RAR/7z reading really needs a helper.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');

function isExecutable(candidate) {
  try {
    const st = fs.statSync(candidate);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function which(command) {
  if (!command) return null;
  if (command.includes(path.sep)) return isExecutable(command) ? command : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, command);
    if (isExecutable(full)) return full;
  }
  return null;
}

function firstOf(list) {
  for (const candidate of list) {
    const found = which(candidate);
    if (found) return found;
  }
  return null;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

let cached = null;
let pillowChecked = false;
let pillowAvailable = false;

function detect(force = false) {
  if (cached && !force) return cached;
  cached = {
    bsdtar: firstOf(['/usr/bin/bsdtar', '/usr/local/bin/bsdtar', '/opt/homebrew/bin/bsdtar', 'bsdtar']),
    // A 7-Zip binary shipped next to the app wins: it needs no system packages
    // and reads RAR, RAR5, 7z and ZIP.
    sevenZip: firstOf([path.join(ROOT, 'bin', '7zz'), path.join(ROOT, 'bin', '7z'), '7zz', '7z', '7za']),
    unar: firstOf(['unar']),
    lsar: firstOf(['lsar']),
    unrar: firstOf(['unrar', '/usr/local/bin/unrar']),
    qlmanage: firstOf(['/usr/bin/qlmanage']),
    sips: firstOf(['/usr/bin/sips']),
    python3: firstOf(['python3', '/usr/bin/python3']),
    gdkThumbnailer: firstOf(['gdk-pixbuf-thumbnailer']),
    magick: firstOf(['magick']),
    convert: firstOf(['convert', '/usr/bin/convert']),
    ffmpeg: firstOf(['ffmpeg', '/opt/homebrew/bin/ffmpeg']),
    pdftocairo: firstOf(['pdftocairo']),
    pdftoppm: firstOf(['pdftoppm']),
    mutool: firstOf(['mutool']),
  };
  cached.pillow = hasPillow(cached.python3);
  return cached;
}

/** Pillow gives a dependency-free downscaler on Linux servers. */
function hasPillow(python3) {
  if (!python3) return false;
  if (pillowChecked) return pillowAvailable;
  pillowChecked = true;
  try {
    require('child_process').execFileSync(python3, ['-c', 'import PIL, PIL.Image'], { timeout: 8000, stdio: 'ignore' });
    pillowAvailable = true;
  } catch {
    pillowAvailable = false;
  }
  return pillowAvailable;
}

/** What the running instance can actually do — logged at startup, shown in the UI. */
function capabilities(tools = detect()) {
  return {
    rar: tools.bsdtar ? 'bsdtar' : tools.sevenZip ? '7zip' : tools.unar || tools.unrar ? 'unar/unrar' : null,
    zip: 'builtin',
    pdfCover: tools.qlmanage ? 'quicklook' : tools.pdftocairo || tools.pdftoppm ? 'poppler' : tools.mutool ? 'mutool' : null,
    resize: tools.sips ? 'sips' : tools.pillow ? 'pillow' : tools.gdkThumbnailer ? 'gdk-pixbuf' : tools.magick || tools.convert ? 'imagemagick' : tools.ffmpeg ? 'ffmpeg' : null,
  };
}

function describe(tools = detect()) {
  const caps = capabilities(tools);
  const lines = [
    'archive: ' + (caps.rar || 'none (RAR/7z unavailable — ZIP still works)'),
    'zip: built-in reader',
    'pdf cover: ' + (caps.pdfCover || 'none (PDF covers will be placeholders)'),
    'resize: ' + (caps.resize || 'none (covers keep their original size)'),
  ];
  return lines;
}

/* ------------------------------------------------------------------ resizing */

/** Downscale `src` into `dest` (JPEG, at most `width` px wide). */
async function resizeImage(src, dest, width) {
  const t = detect();
  if (t.sips) {
    try {
      await run(t.sips, ['-s', 'format', 'jpeg', '-Z', String(width), src, '--out', dest], 30000);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    } catch { /* try the next tool */ }
  }
  if (t.pillow) {
    const script =
      'import sys\n' +
      'from PIL import Image, ImageOps\n' +
      'src, dest, width = sys.argv[1], sys.argv[2], int(sys.argv[3])\n' +
      'im = Image.open(src)\n' +
      'im = ImageOps.exif_transpose(im)\n' +
      'if im.mode in ("RGBA", "LA", "P"):\n' +
      '    bg = Image.new("RGB", im.size, (255, 255, 255))\n' +
      '    im = im.convert("RGBA")\n' +
      '    bg.paste(im, mask=im.split()[-1])\n' +
      '    im = bg\n' +
      'else:\n' +
      '    im = im.convert("RGB")\n' +
      'im.thumbnail((width, width * 4), Image.LANCZOS)\n' +
      'im.save(dest, "JPEG", quality=82, optimize=True)\n';
    try {
      await run(t.python3, ['-c', script, src, dest, String(width)], 40000);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    } catch { /* try the next tool */ }
  }
  if (t.gdkThumbnailer) {
    try {
      await run(t.gdkThumbnailer, ['-s', String(width), src, dest], 30000);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    } catch { /* try the next tool */ }
  }
  const magick = t.magick || t.convert;
  if (magick) {
    try {
      await run(magick, [src + '[0]', '-thumbnail', String(width) + 'x' + width * 4 + '>', '-quality', '82', dest], 40000);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    } catch { /* try the next tool */ }
  }
  if (t.ffmpeg) {
    try {
      await run(t.ffmpeg, ['-y', '-i', src, '-vf', 'scale=' + width + ':-2', '-q:v', '4', dest], 40000);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return true;
    } catch { /* fall through */ }
  }
  return false;
}

/* --------------------------------------------------------------- pdf covers */

/**
 * Render page 1 of a PDF to a JPEG/PNG in `tmpDir`.
 * Returns `{ file, preSized }` or null.
 */
async function pdfFirstPage(pdfPath, tmpDir, width) {
  const t = detect();
  const target = Math.max(320, Math.round(width * 1.6));

  if (t.qlmanage) {
    try {
      await run(t.qlmanage, ['-t', '-s', String(target), '-o', tmpDir, pdfPath], 45000);
    } catch {
      /* qlmanage exits non-zero even on success */
    }
    const base = path.basename(pdfPath);
    const produced = safeReaddir(tmpDir)
      .filter((n) => n.startsWith(base) || /\.(png|jpg|jpeg)$/i.test(n))
      .map((n) => path.join(tmpDir, n))
      .filter((p) => existsWithSize(p));
    if (produced[0]) return { file: produced[0], preSized: false };
  }

  const out = path.join(tmpDir, 'pdfcover');
  for (const cmd of [t.pdftocairo, t.pdftoppm]) {
    if (!cmd) continue;
    const flags = ['-jpeg', '-singlefile', '-scale-to', String(target)];
    try {
      await run(cmd, flags.concat([pdfPath, out]), 60000);
    } catch { /* try the next tool */ }
    for (const ext of ['.jpg', '.jpeg', '.png']) {
      if (existsWithSize(out + ext)) return { file: out + ext, preSized: false };
    }
  }

  if (t.mutool) {
    const png = path.join(tmpDir, 'pdfcover.png');
    try {
      await run(t.mutool, ['draw', '-o', png, '-w', String(target), pdfPath, '1'], 60000);
    } catch { /* fall through */ }
    if (existsWithSize(png)) return { file: png, preSized: false };
  }
  return null;
}

function existsWithSize(p, min = 200) {
  try {
    return fs.statSync(p).size >= min;
  } catch {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

module.exports = { detect, capabilities, describe, resizeImage, pdfFirstPage, which, run, ROOT };
