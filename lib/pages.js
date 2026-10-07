'use strict';

/**
 * Turns any catalog unit (archive, MOBI, image folder, EPUB) into an ordered
 * list of page images, using a local cache so the NAS is read once per volume.
 *
 * - archives / mobi / epub: extracted into `cache/extract/<unitId>/`
 * - image folders: listed in place (already files on disk), nothing copied
 * - pdf: not paged here, the browser renders it through /api/file with ranges
 */

const fs = require('fs');
const path = require('path');
const util = require('./util');
const archive = require('./archive');
const mobi = require('./mobi');

const MANIFEST = 'manifest.json';

class PageStore {
  constructor(config, library, onEvent) {
    this.config = config;
    this.library = library;
    this.onEvent = onEvent || (() => {});
    this.jobs = new Map();
    this.running = new Set();
    this.limiter = util.createLimiter(Math.max(1, config.jobs));
    this.pdfMetaFile = path.join(config.dataDir, 'pdfmeta.json');
    this.pdfMeta = this.loadPdfMeta();
    this._pdfSaveTimer = null;
  }

  // ------------------------------------------------------------- pdf counts

  loadPdfMeta() {
    try {
      return JSON.parse(fs.readFileSync(this.pdfMetaFile, 'utf8'));
    } catch {
      return {};
    }
  }

  savePdfMeta() {
    if (this._pdfSaveTimer) return;
    this._pdfSaveTimer = setTimeout(() => {
      this._pdfSaveTimer = null;
      try {
        fs.writeFileSync(this.pdfMetaFile, JSON.stringify(this.pdfMeta), 'utf8');
      } catch (err) {
        console.error('Could not save pdf meta: ' + err.message);
      }
    }, 500);
    if (this._pdfSaveTimer.unref) this._pdfSaveTimer.unref();
  }

  setPageCount(unitId, pageCount) {
    if (!Number.isFinite(pageCount) || pageCount <= 0) return;
    this.pdfMeta[unitId] = { pageCount: Math.round(pageCount), at: Date.now() };
    this.savePdfMeta();
  }

  cachedPageCount(unit) {
    const m = this.readManifest(unit.id);
    if (m && m.pages) return m.pages.length;
    if (unit.kind === 'imageDir') return unit.pageCount || null;
    const p = this.pdfMeta[unit.id];
    return p ? p.pageCount : null;
  }

  // -------------------------------------------------------------- manifests

  dirFor(unitId) {
    return path.join(this.config.cacheDir, 'extract', unitId);
  }

  manifestPath(unitId) {
    return path.join(this.dirFor(unitId), MANIFEST);
  }

  readManifest(unitId) {
    try {
      const m = JSON.parse(fs.readFileSync(this.manifestPath(unitId), 'utf8'));
      if (m && Array.isArray(m.pages)) return m;
    } catch {
      /* not extracted yet */
    }
    return null;
  }

  writeManifest(unitId, data) {
    const dir = this.dirFor(unitId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.manifestPath(unitId), JSON.stringify(data), 'utf8');
  }

  manifestFresh(unit, manifest) {
    if (!manifest) return false;
    if (manifest.kind !== unit.kind) return false;
    if (manifest.source !== unit.path) return false;
    // Only compare values the manifest actually recorded: the scanner fills in
    // sizes/mtimes lazily, and that learning must not invalidate an extraction.
    if (manifest.sourceMtimeMs != null && unit.mtimeMs != null && manifest.sourceMtimeMs !== unit.mtimeMs) return false;
    if (manifest.sourceSize != null && unit.size != null && manifest.sourceSize !== unit.size) return false;
    if (manifest.kind === 'imageDir' && manifest.sourceMtimeMs != null && unit.dirMtimeMs != null && manifest.sourceMtimeMs !== unit.dirMtimeMs) {
      return false;
    }
    return true;
  }

  // ----------------------------------------------------------------- status

  /** What the client should show for this unit right now. */
  describe(unit, { start = true } = {}) {
    if (!unit) return { status: 'error', error: 'unknown unit' };

    if (unit.kind === 'pdf' || unit.kind === 'book') {
      const meta = this.pdfMeta[unit.id];
      return {
        status: 'ready',
        kind: 'pdf',
        unitId: unit.id,
        title: unit.title,
        pageCount: meta ? meta.pageCount : null,
        fileUrl: '/api/file/' + unit.id,
        downloadUrl: '/api/download/' + unit.id,
      };
    }

    const manifest = this.readManifest(unit.id);
    if (this.manifestFresh(unit, manifest)) {
      return this.readyDescriptor(unit, manifest);
    }

    const job = this.jobs.get(unit.id);
    if (job) {
      if (job.status === 'running') {
        return { status: 'running', kind: unit.kind, unitId: unit.id, progress: job.progress };
      }
      if (job.status === 'error') {
        return { status: 'error', kind: unit.kind, unitId: unit.id, error: job.error || 'extraction failed' };
      }
      // The job claims success but the cache is gone (evicted or replaced):
      // forget it and extract again rather than reporting empty pages.
      this.jobs.delete(unit.id);
    }

    if (start) {
      this.start(unit);
      return { status: 'running', kind: unit.kind, unitId: unit.id, progress: { done: 0, total: 0 } };
    }
    return { status: 'idle', kind: unit.kind, unitId: unit.id };
  }

  readyDescriptor(unit, manifest) {
    const pages = manifest.pages.map((p, i) => ({
      index: i,
      name: typeof p === 'string' ? p : p.name,
      url: '/api/page/' + unit.id + '/' + i,
    }));
    return {
      status: 'ready',
      kind: manifest.kind,
      unitId: unit.id,
      title: unit.title,
      pageCount: pages.length,
      pages,
      coverIndex: manifest.coverIndex || 0,
      downloadUrl: '/api/download/' + unit.id,
      extractedAt: manifest.extractedAt || null,
    };
  }

  /** Page file on disk for a ready unit (local cache or the NAS folder). */
  pageFile(unit, index) {
    const manifest = this.readManifest(unit.id);
    if (!this.manifestFresh(unit, manifest)) return null;
    const entry = manifest.pages[index];
    if (entry == null) return null;
    const rel = typeof entry === 'string' ? entry : entry.file || entry.name;
    // Folders of images are read in place; everything else is in the cache.
    const base = manifest.inPlace ? manifest.source : this.dirFor(unit.id);
    if (!base) return null;
    const full = path.resolve(base, rel);
    if (!util.isInside(base, full)) return null;
    return fs.existsSync(full) ? full : null;
  }

  /** Remove scratch directories left behind by a crash or a hard kill. */
  cleanScratch() {
    const dir = path.join(this.config.cacheDir, 'extract');
    let removed = 0;
    for (const name of safeReaddir(dir)) {
      if (!name.includes('.tmp')) continue;
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed++;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** Drop cached extractions whose source files no longer exist in the index. */
  purgeStale() {
    const dir = path.join(this.config.cacheDir, 'extract');
    let removed = 0;
    for (const name of safeReaddir(dir)) {
      // Scratch directories belong to a running extraction: never touch them.
      if (name.includes('.tmp')) continue;
      if (!this.library.unitById(name)) {
        try {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }

  /** Evict the oldest extractions once the cache budget is exceeded. */
  enforceLimit() {
    const limitBytes = this.config.cacheLimitGB * 1024 * 1024 * 1024;
    const dir = path.join(this.config.cacheDir, 'extract');
    const entries = [];
    let total = 0;
    for (const name of safeReaddir(dir)) {
      if (name.includes('.tmp')) continue;
      const m = this.readManifest(name);
      const bytes = m ? m.bytes || 0 : 0;
      total += bytes;
      entries.push({ name, bytes, at: m ? m.extractedAt || 0 : 0 });
    }
    if (total <= limitBytes) return 0;
    entries.sort((a, b) => a.at - b.at);
    const target = limitBytes * 0.9;
    let removed = 0;
    for (const e of entries) {
      if (total <= target) break;
      try {
        fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
        total -= e.bytes;
        removed++;
      } catch {
        /* ignore */
      }
    }
    if (removed) this.onEvent({ type: 'cache', evicted: removed, bytes: total });
    return removed;
  }

  // ------------------------------------------------------------- extraction

  start(unit) {
    if (this.jobs.has(unit.id) || this.running.has(unit.id)) return;
    const job = { status: 'running', progress: { done: 0, total: 0 }, startedAt: Date.now() };
    this.jobs.set(unit.id, job);
    this.onEvent({ type: 'extract', unitId: unit.id, status: 'running', progress: job.progress });
    this.limiter(() => this.run(unit, job)).catch((err) => {
      job.status = 'error';
      job.error = err.message;
      this.onEvent({ type: 'extract', unitId: unit.id, status: 'error', error: err.message });
    });
  }

  async run(unit, job) {
    const dir = this.dirFor(unit.id);
    // A unique scratch directory per run: nothing else can delete files out
    // from under a write that is still in flight.
    const tmp = dir + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    this.running.add(unit.id);
    fs.mkdirSync(tmp, { recursive: true });
    let manifest = null;
    try {
      if (unit.kind === 'imageDir') manifest = await this.extractImageDir(unit, job);
      else if (unit.kind === 'archive') manifest = await this.extractArchive(unit, tmp, job);
      else if (unit.kind === 'mobi') manifest = await this.extractMobi(unit, tmp, job);
      else if (unit.kind === 'epub') manifest = await this.extractEpub(unit, tmp, job);
      else throw new Error('unsupported format: ' + unit.kind);

      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(tmp, dir);
      this.writeManifest(unit.id, manifest);
      job.status = 'ready';
      job.progress = { done: manifest.pages.length, total: manifest.pages.length };
      this.onEvent({ type: 'extract', unitId: unit.id, status: 'ready', pageCount: manifest.pages.length });
      this.enforceLimit();
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      job.status = 'error';
      job.error = err.message;
      this.onEvent({ type: 'extract', unitId: unit.id, status: 'error', error: err.message });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      this.running.delete(unit.id);
      // Keep the job around briefly so a polling client sees the final state.
      setTimeout(() => {
        if (this.jobs.get(unit.id) === job) this.jobs.delete(unit.id);
      }, 30000).unref?.();
    }
    return manifest;
  }

  async extractImageDir(unit, job) {
    let entries;
    try {
      entries = await fs.promises.readdir(unit.path, { withFileTypes: true });
    } catch (err) {
      throw new Error('cannot read folder: ' + err.message);
    }
    const names = entries
      .filter((e) => e.isFile() && archive.isImageEntry(e.name))
      .map((e) => e.name)
      .sort(util.naturalCompare);
    if (!names.length) throw new Error('no images in folder');
    job.progress = { done: names.length, total: names.length };
    const st = await util.statOrNull(unit.path);
    return {
      unitId: unit.id,
      kind: 'imageDir',
      source: unit.path,
      sourceMtimeMs: st ? st.mtimeMs : null,
      sourceSize: null,
      inPlace: true,
      pages: names,
      coverIndex: 0,
      bytes: 0,
      extractedAt: Date.now(),
    };
  }

  async extractArchive(unit, tmp, job) {
    const entries = await archive.listImageEntries(unit.path);
    if (!entries.length) throw new Error('no images inside archive');
    job.progress = { done: 0, total: entries.length };
    await archive.extractAll(unit.path, tmp);
    const rel = await archive.findImages(tmp);
    if (!rel.length) throw new Error('no images extracted');
    rel.sort(util.naturalCompare);
    job.progress = { done: rel.length, total: rel.length };
    return {
      unitId: unit.id,
      kind: 'archive',
      source: unit.path,
      sourceMtimeMs: unit.mtimeMs,
      sourceSize: unit.size,
      pages: rel,
      coverIndex: 0,
      bytes: dirSizeSync(tmp),
      extractedAt: Date.now(),
    };
  }

  async extractMobi(unit, tmp, job) {
    const info = await mobi.listImages(unit.path);
    if (!info.pages.length) throw new Error('no images inside mobi');
    job.progress = { done: 0, total: info.pages.length };
    const pages = [];
    for (let i = 0; i < info.pages.length; i++) {
      const page = info.pages[i];
      const name = String(i + 1).padStart(5, '0') + '.' + (page.type === 'jpg' ? 'jpg' : page.type);
      await mobi.writeImage(unit.path, page, path.join(tmp, name));
      pages.push(name);
      job.progress = { done: i + 1, total: info.pages.length };
    }
    return {
      unitId: unit.id,
      kind: 'mobi',
      source: unit.path,
      sourceMtimeMs: unit.mtimeMs,
      sourceSize: unit.size,
      pages,
      coverIndex: info.coverIndex >= 0 && info.coverIndex < pages.length ? info.coverIndex : 0,
      bytes: dirSizeSync(tmp),
      extractedAt: Date.now(),
    };
  }

  async extractEpub(unit, tmp, job) {
    await archive.extractAll(unit.path, tmp);
    let order = await epubSpineImages(tmp);
    if (!order || !order.length) order = await archive.findImages(tmp);
    if (!order.length) throw new Error('no images inside epub');
    order.sort(util.naturalCompare);
    job.progress = { done: order.length, total: order.length };
    return {
      unitId: unit.id,
      kind: 'epub',
      source: unit.path,
      sourceMtimeMs: unit.mtimeMs,
      sourceSize: unit.size,
      pages: order,
      coverIndex: 0,
      bytes: dirSizeSync(tmp),
      extractedAt: Date.now(),
    };
  }
}

/** Image order from an EPUB spine (comic epubs are usually image-only). */
async function epubSpineImages(root) {
  const container = path.join(root, 'META-INF', 'container.xml');
  let opfRel = null;
  try {
    const xml = await fs.promises.readFile(container, 'utf8');
    const m = /full-path="([^"]+)"/.exec(xml);
    if (m) opfRel = m[1];
  } catch {
    return null;
  }
  if (!opfRel) return null;
  const opfPath = path.join(root, opfRel);
  let opf;
  try {
    opf = await fs.promises.readFile(opfPath, 'utf8');
  } catch {
    return null;
  }
  const opfDir = path.dirname(opfPath);
  const items = new Map();
  const itemRe = /<item\b[^>]*>/g;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = /id="([^"]+)"/.exec(tag);
    const href = /href="([^"]+)"/.exec(tag);
    const type = /media-type="([^"]+)"/.exec(tag);
    if (id && href) items.set(id[1], { href: href[1], type: type ? type[1] : '' });
  }
  const spine = [];
  const refRe = /<itemref\b[^>]*idref="([^"]+)"/g;
  while ((m = refRe.exec(opf))) spine.push(m[1]);

  const out = [];
  for (const idref of spine) {
    const item = items.get(idref);
    if (!item) continue;
    const abs = path.resolve(opfDir, decodeURIComponent(item.href));
    if (!util.isInside(root, abs)) continue;
    if (item.type.startsWith('image/') || archive.isImageEntry(abs)) {
      out.push(path.relative(root, abs));
      continue;
    }
    // XHTML page: pull its <img src> references in document order.
    try {
      const html = await fs.promises.readFile(abs, 'utf8');
      const imgRe = /<img\b[^>]*src="([^"]+)"/g;
      let im;
      while ((im = imgRe.exec(html))) {
        const src = path.resolve(path.dirname(abs), decodeURIComponent(im[1]));
        if (util.isInside(root, src) && archive.isImageEntry(src)) out.push(path.relative(root, src));
      }
    } catch {
      /* skip unreadable page */
    }
  }
  return out;
}

function dirSizeSync(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSizeSync(full);
    else if (e.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

module.exports = { PageStore };
