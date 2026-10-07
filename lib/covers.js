'use strict';

/**
 * Cover (thumbnail) generation and cache.
 *
 * Covers are produced on demand — for archives and MOBI files only the first
 * page is decoded, never the whole volume — and stored under
 * `cache/covers/<id>.jpg`. A small worker pool keeps the NAS from being
 * hammered while the grid fills in progressively.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./util');
const archive = require('./archive');
const mobi = require('./mobi');
const tools = require('./tools');

class CoverStore {
  constructor(config, library, pageStore, onEvent) {
    this.config = config;
    this.library = library;
    this.pageStore = pageStore;
    this.onEvent = onEvent || (() => {});
    this.dir = path.join(config.cacheDir, 'covers');
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = [];
    this.active = 0;
    this.inflight = new Map(); // id -> Promise
    this.failed = new Map(); // id -> timestamp of last failed attempt
    this.failCooldownMs = 10 * 60 * 1000;
    this.concurrency = Math.max(1, Math.min(4, config.jobs + 1));
    this.pregen = { running: false, done: 0, total: 0, startedAt: 0, cancelled: false };
  }

  fileFor(id) {
    return path.join(this.dir, id + '.jpg');
  }

  /** A cover that could not be produced is not retried for a while. */
  recentlyFailed(id) {
    const at = this.failed.get(id);
    if (!at) return false;
    if (Date.now() - at > this.failCooldownMs) {
      this.failed.delete(id);
      return false;
    }
    return true;
  }

  has(id) {
    try {
      return fs.statSync(this.fileFor(id)).size > 0;
    } catch {
      return false;
    }
  }

  version(id) {
    try {
      return Math.round(fs.statSync(this.fileFor(id)).mtimeMs);
    } catch {
      return 0;
    }
  }

  /** Series/group/root ids resolve to a real volume to render a cover from. */
  resolveUnit(id) {
    const unit = this.library.unitById(id);
    if (unit) return unit;
    const series = this.library.seriesById(id);
    if (series) {
      if (series.coverUnitId && this.library.unitById(series.coverUnitId)) return this.library.unitById(series.coverUnitId);
      return series.units.find((u) => u.kind !== 'book') || series.units[0] || null;
    }
    const node = this.library.nodeById(id);
    if (node && (node.kind === 'group' || node.kind === 'root')) {
      const stack = [...(node.children || [])];
      while (stack.length) {
        const child = stack.shift();
        if (child.kind === 'series') {
          const u = this.resolveUnit(child.id);
          if (u) return u;
        } else if (child.kind === 'group') {
          stack.push(...(child.children || []));
        } else if (child.kind && child.path) {
          return child;
        }
      }
    }
    return null;
  }

  /** Cover path, generating it in the background when missing. */
  async get(id, { wait = false, timeout = 20000 } = {}) {
    if (this.has(id)) return this.fileFor(id);
    if (this.recentlyFailed(id)) return null;
    const unit = this.resolveUnit(id);
    if (!unit) return null;
    const promise = this.enqueue(id, unit);
    if (!wait) return null;
    const raced = await Promise.race([
      promise.then(() => this.fileFor(id)),
      util.sleep(timeout).then(() => null),
    ]);
    return raced && this.has(id) ? this.fileFor(id) : null;
  }

  enqueue(id, unit) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const promise = new Promise((resolve) => {
      this.queue.push({ id, unit, resolve });
      this.pump();
    });
    this.inflight.set(id, promise);
    promise.finally(() => this.inflight.delete(id));
    return promise;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.generate(job.id, job.unit)
        .catch(() => false)
        .then((ok) => {
          this.active--;
          job.resolve(ok);
          if (ok) {
            this.failed.delete(job.id);
          } else {
            this.failed.set(job.id, Date.now());
          }
          this.onEvent({ type: 'cover', id: job.id, ok: !!ok });
          this.pump();
        });
    }
  }

  status(ids) {
    const ready = [];
    const pending = [];
    const missing = [];
    const failed = [];
    for (const id of ids) {
      if (this.has(id)) {
        ready.push({ id, version: this.version(id) });
        continue;
      }
      const unit = this.resolveUnit(id);
      if (!unit) {
        missing.push(id);
        continue;
      }
      if (this.recentlyFailed(id)) {
        failed.push(id);
        continue;
      }
      pending.push(id);
      this.enqueue(id, unit);
    }
    return { ready, pending, missing, failed };
  }

  // ------------------------------------------------------------ generation

  async generate(id, unit) {
    const dest = this.fileFor(id);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mangamgr-cover-'));
    try {
      const source = await this.sourceImage(unit, tmpDir);
      const src = typeof source === 'string' ? source : source && source.file;
      const preSized = !!(source && source.preSized);
      if (!src) return false;
      const ok = preSized ? copyFile(src, dest) : await this.toCover(src, dest);
      if (ok) return true;
      // Last resort: keep the raw page as the cover when it is small enough.
      try {
        const st = fs.statSync(src);
        if (st.size > 0 && st.size < 2 * 1024 * 1024) {
          fs.copyFileSync(src, dest);
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    }
  }

  /** An image file on local disk that represents the volume's first page. */
  async sourceImage(unit, tmpDir) {
    switch (unit.kind) {
      case 'imageDir': {
        const manifest = this.pageStore.readManifest(unit.id);
        if (manifest && manifest.pages && manifest.pages.length) {
          const f = this.pageStore.pageFile(unit, manifest.coverIndex || 0) || this.pageStore.pageFile(unit, 0);
          if (f) return f;
        }
        const desc = await this.readyDescriptor(unit);
        if (!desc) return null;
        return this.pageStore.pageFile(unit, desc.coverIndex || 0) || this.pageStore.pageFile(unit, 0);
      }
      case 'archive':
      case 'epub': {
        const entries = await archive.listImageEntries(unit.path);
        if (!entries.length) return null;
        const out = path.join(tmpDir, 'page' + (path.extname(entries[0]) || '.jpg'));
        try {
          await archive.extractEntryTo(unit.path, entries[0], out, entries);
          if (fs.existsSync(out) && fs.statSync(out).size > 200) return out;
        } catch {
          /* fall back to a full extraction below */
        }
        const sub = path.join(tmpDir, 'all');
        fs.mkdirSync(sub, { recursive: true });
        await archive.extractAll(unit.path, sub);
        const rel = (await archive.findImages(sub)).sort(util.naturalCompare);
        if (!rel.length) return null;
        const first = path.join(sub, rel[0]);
        return fs.existsSync(first) && fs.statSync(first).size > 200 ? first : null;
      }
      case 'mobi': {
        const info = await mobi.listImages(unit.path);
        if (!info.pages.length) return null;
        const idx = info.coverIndex >= 0 && info.coverIndex < info.pages.length ? info.coverIndex : 0;
        const ext = info.pages[idx].type === 'jpg' ? '.jpg' : '.' + info.pages[idx].type;
        const out = path.join(tmpDir, 'cover' + ext);
        await mobi.writeImage(unit.path, info.pages[idx], out);
        return fs.existsSync(out) && fs.statSync(out).size > 200 ? out : null;
      }
      case 'pdf': {
        // qlmanage on macOS, poppler (pdftocairo/pdftoppm) or mutool elsewhere.
        return await tools.pdfFirstPage(unit.path, tmpDir, this.config.coverWidth);
      }
      default:
        return null;
    }
  }

  async readyDescriptor(unit) {
    const desc = this.pageStore.describe(unit, { start: true });
    if (desc.status === 'ready') return desc;
    if (desc.status === 'error') return null;
    for (let i = 0; i < 120; i++) {
      await util.sleep(250);
      const again = this.pageStore.describe(unit, { start: false });
      if (again.status === 'ready') return again;
      if (again.status === 'error') return null;
    }
    return null;
  }

  async toCover(src, dest) {
    return tools.resizeImage(src, dest, this.config.coverWidth);
  }

  // ------------------------------------------------------------- pregenerate

  startPregen() {
    if (this.pregen.running) return this.pregen;
    const ids = [];
    for (const series of this.library.series.values()) ids.push(series.id);
    for (const id of this.library.nodes.keys()) {
      if (!this.library.seriesById(id) && !this.library.unitById(id)) ids.push(id);
    }
    this.pregen = { running: true, done: 0, total: ids.length, startedAt: Date.now(), cancelled: false };
    this.pumpPregen(ids).catch(() => {
      this.pregen.running = false;
    });
    return this.pregen;
  }

  stopPregen() {
    this.pregen.cancelled = true;
    this.pregen.running = false;
  }

  async pumpPregen(ids) {
    for (const id of ids) {
      if (this.pregen.cancelled) break;
      if (this.has(id)) {
        this.pregen.done++;
        continue;
      }
      const unit = this.resolveUnit(id);
      if (unit) await this.enqueue(id, unit);
      this.pregen.done++;
      if (this.pregen.done % 5 === 0) {
        this.onEvent({ type: 'pregen', ...this.pregen });
      }
    }
    this.pregen.running = false;
    this.onEvent({ type: 'pregen', ...this.pregen, finished: true });
  }

  /** Covers for units that vanished from the index are dead weight. */
  purgeStale() {
    let removed = 0;
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const id = name.replace(/\.jpg$/, '');
      if (!this.library.nodeById(id)) {
        try {
          fs.unlinkSync(path.join(this.dir, name));
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }
}

function copyFile(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    return fs.statSync(dest).size > 0;
  } catch {
    return false;
  }
}

module.exports = { CoverStore };
