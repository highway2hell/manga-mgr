'use strict';

const fs = require('fs');
const path = require('path');
const util = require('./util');

const INDEX_VERSION = 5;

// Folders that NAS boxes and sync tools create and that never hold manga.
const BUILTIN_EXCLUDE = new Set([
  '@eaDir',
  '#recycle',
  '@Recycle',
  '.@__thumb',
  'System Volume Information',
  '$RECYCLE.BIN',
  'lost+found',
  'node_modules',
]);

const UNIT_KINDS = new Set(['pdf', 'archive', 'mobi', 'epub', 'book', 'imageDir']);

function isUnit(node) {
  return node && UNIT_KINDS.has(node.kind);
}

function kindForExt(ext, cfg) {
  if (cfg.archiveExtensions.includes(ext)) return 'archive';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.mobi' || ext === '.azw3' || ext === '.fb2') return 'mobi';
  if (ext === '.epub') return 'epub';
  if (cfg.bookExtensions.includes(ext)) return 'book';
  return null;
}

function sortChildren(nodes) {
  const rank = (n) => (n.kind === 'group' ? 0 : n.kind === 'series' ? 1 : 2);
  return nodes.slice().sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return util.naturalCompare(a.title || a.name, b.title || b.name);
  });
}

class Library {
  constructor(config) {
    this.config = config;
    this.tree = { version: INDEX_VERSION, scannedAt: 0, roots: [] };
    this.units = new Map();
    this.series = new Map();
    this.nodes = new Map();
    this.scannedAt = 0;
    this.scanErrors = [];
    this.state = { running: false, reused: 0, visited: 0, units: 0, error: null, startedAt: 0, finishedAt: 0 };
    this.listeners = new Set();
    this._saveTimer = null;
  }

  indexFile() {
    return path.join(this.config.dataDir, 'index.json');
  }

  get stats() {
    let seriesCount = 0;
    let unitCount = 0;
    let totalSize = 0;
    let knownSize = 0;
    for (const s of this.series.values()) {
      seriesCount++;
      for (const u of s.units) {
        unitCount++;
        if (u.size != null) {
          totalSize += u.size;
          knownSize++;
        }
      }
    }
    return {
      series: seriesCount,
      units: unitCount,
      size: totalSize,
      sizeKnown: knownSize,
      roots: this.tree.roots.length,
      scannedAt: this.scannedAt,
      scanErrors: this.scanErrors.length,
    };
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a broken listener must not break a scan */
      }
    }
  }

  // ---------------------------------------------------------------- loading

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8'));
      if (raw && raw.version === INDEX_VERSION && raw.tree) {
        this.tree = raw.tree;
        this.scannedAt = raw.scannedAt || 0;
        this.scanErrors = raw.scanErrors || [];
        this.finalize();
        return true;
      }
    } catch {
      /* no usable cache: first run */
    }
    return false;
  }

  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  saveNow() {
    const payload = {
      version: INDEX_VERSION,
      scannedAt: this.scannedAt,
      scanErrors: this.scanErrors.slice(0, 200),
      tree: this.tree,
      stats: this.stats,
    };
    const file = this.indexFile();
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error('Could not write index: ' + err.message);
    }
  }

  // -------------------------------------------------------------- scanning

  /**
   * Walk every library root and build the catalog tree.
   * Directory mtimes are compared against the previous index so an unchanged
   * folder is reused without listing its (thousands of) files — the difference
   * between a ~30 s and a ~2 s scan on a NAS mount.
   */
  async scan({ force = false, onProgress } = {}) {
    if (this.state.running) return this.stats;
    this.state = { running: true, reused: 0, visited: 0, units: 0, error: null, startedAt: Date.now(), finishedAt: 0 };
    const ctx = {
      errors: [],
      prevDirs: new Map(),
      parentOf: new Map(),
      dirty: null,
      reuseEnabled: false,
      visited: 0,
      units: 0,
      reused: 0,
      imageExts: new Set(this.config.imageExtensions),
      archiveExts: new Set(this.config.archiveExtensions),
      bookExts: new Set(this.config.bookExtensions),
      ignoreExts: new Set(this.config.ignoreExtensions),
      excludeNames: new Set([...BUILTIN_EXCLUDE, ...this.config.excludeNames]),
      statLimit: util.createLimiter(24),
      onProgress,
      lastEmit: 0,
    };

    // Index every directory of the previous scan, so an unchanged folder can be
    // adopted without listing its files again.
    const register = (node, parentPath) => {
      if (!node || !node.path) return;
      const isDir = node.kind === 'root' || node.kind === 'group' || node.kind === 'series' || node.kind === 'imageDir';
      if (!isDir) return;
      ctx.prevDirs.set(node.path, { node, mtimeMs: node.mtimeMs });
      ctx.parentOf.set(node.path, parentPath || null);
      const kids = node.children || node.units || [];
      for (const kid of kids) register(kid, node.path);
    };
    for (const root of this.tree.roots) register(root, null);

    if (!force && ctx.prevDirs.size) {
      ctx.reuseEnabled = true;
      ctx.dirty = await this.findDirty(ctx);
      if (onProgress) onProgress({ phase: 'check', dirs: ctx.prevDirs.size, dirty: ctx.dirty.size });
    }

    const roots = [];
    try {
      for (const dir of this.config.libraryDirs) {
        const root = await this.walkRoot(dir, ctx);
        if (root) roots.push(root);
      }
    } catch (err) {
      this.state.error = err.message;
      ctx.errors.push('scan failed: ' + err.message);
    }

    this.tree = { version: INDEX_VERSION, roots };
    this.scanErrors = ctx.errors;
    this.scannedAt = Date.now();
    this.state.running = false;
    this.state.reused = ctx.reused;
    this.state.visited = ctx.visited;
    this.state.units = ctx.units;
    this.state.finishedAt = Date.now();
    this.finalize();
    this.saveNow();
    this.emit({ type: 'scan', phase: 'done', ...this.state, stats: this.stats });
    return this.stats;
  }

  /**
   * Which folders changed since the last scan? Only a stat per known folder is
   * needed: adding or removing anything bumps the mtime of the folder holding
   * it, and changed folders mark all of their ancestors for a fresh walk.
   */
  async findDirty(ctx) {
    const items = [];
    for (const [dirPath, prev] of ctx.prevDirs) {
      items.push({ path: dirPath, owner: dirPath, mtimeMs: prev.mtimeMs });
      // Folders collapsed into one volume ("Vol/Vol/pages") are checked too.
      for (const chain of prev.node.chainDirs || []) {
        items.push({ path: chain.path, owner: dirPath, mtimeMs: chain.mtimeMs });
      }
    }
    const stats = await util.mapLimit(items, 24, (it) => util.statOrNull(it.path));
    const changed = new Set();
    items.forEach((item, i) => {
      const st = stats[i];
      if (!st || st.mtimeMs !== item.mtimeMs) changed.add(item.owner);
    });

    // A changed folder forces its ancestors to be re-read, so the walk can
    // reach it; everything else is adopted from the previous index.
    const dirty = new Set();
    for (const dirPath of changed) {
      let current = dirPath;
      let guard = 0;
      while (current && guard++ < 64) {
        dirty.add(current);
        current = ctx.parentOf.get(current) || null;
      }
    }
    return dirty;
  }

  async walkRoot(dir, ctx) {
    const node = await this.walkDir(dir.path, ctx, true);
    if (!node) {
      ctx.errors.push('No readable manga found in ' + dir.path);
      return null;
    }
    if (node.kind === 'root') {
      // A root reused from the previous index: keep the caller's label.
      node.name = dir.name;
      node.title = dir.name;
      node.parentId = null;
      return node;
    }
    return {
      kind: 'root',
      id: util.idFor('root:' + dir.path),
      name: dir.name,
      title: dir.name,
      path: dir.path,
      mtimeMs: node.mtimeMs,
      children: node.kind === 'group' ? node.children : [node],
    };
  }

  async walkDir(dirAbs, ctx) {
    if (!ctx.force) {
      const reused = await this.tryReuse(dirAbs, ctx);
      if (reused !== undefined) return reused;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      ctx.errors.push(dirAbs + ': ' + err.message);
      return null;
    }

    ctx.visited++;
    if (ctx.onProgress) {
      const now = Date.now();
      if (now - ctx.lastEmit > 120) {
        ctx.lastEmit = now;
        ctx.onProgress({ phase: 'walk', dirs: ctx.visited, units: ctx.units, current: dirAbs });
      }
    }

    const subdirs = [];
    const unitFiles = [];
    const imageFiles = [];
    for (const entry of entries) {
      const name = entry.name;
      if (util.isHiddenName(name) || ctx.excludeNames.has(name)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        subdirs.push(name);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = util.extname(name);
      if (!ext || ctx.ignoreExts.has(ext)) continue;
      if (ctx.archiveExts.has(ext) || ctx.bookExts.has(ext)) unitFiles.push(name);
      else if (ctx.imageExts.has(ext)) imageFiles.push(name);
    }

    const childNodes = [];
    for (const name of subdirs) {
      const node = await this.walkDir(path.join(dirAbs, name), ctx);
      if (node) childNodes.push(node);
    }

    const ownUnits = [];
    if (unitFiles.length) {
      const made = await Promise.all(
        unitFiles.map((name) =>
          ctx.statLimit(async () => {
            const full = path.join(dirAbs, name);
            const st = await util.statOrNull(full);
            return this.makeFileUnit(full, name, st);
          })
        )
      );
      for (const u of made) if (u) ownUnits.push(u);
      ctx.units += ownUnits.length;
    }

    // A folder whose only content is a pile of images is one volume.
    if (subdirs.length === 0 && unitFiles.length === 0 && imageFiles.length >= 2) {
      return this.makeImageDirUnit(dirAbs, imageFiles, await util.statOrNull(dirAbs));
    }


    const name = path.basename(dirAbs) || dirAbs;
    const total = childNodes.length + ownUnits.length;

    if (total === 0) return null;

    if (total === 1 && ownUnits.length === 0) {
      const only = childNodes[0];
      // Collapse "Volume/Volume/pages" and "Work/only-subdir/series" chains.
      if (only.kind === 'imageDir') {
        only.chainDepth = (only.chainDepth || 0) + 1;
        only.name = name;
        only.title = util.cleanTitle(name) || name;
        // Remember the folder that was skipped so the incremental scan still
        // notices when something changes there.
        const outer = await util.statOrNull(dirAbs);
        const chainDirs = (only.chainDirs || []).concat([{ path: dirAbs, mtimeMs: outer ? outer.mtimeMs : null }]);
        only.chainDirs = chainDirs;
      }
      return only;
    }

    if (total === 1 && childNodes.length === 0) {
      ownUnits[0].dirName = name;
      return ownUnits[0];
    }

    // A folder that directly holds readable files is itself a series; a nested
    // series folder below it is just another chapter level, so fold it in.
    const flatten = ownUnits.length > 0;
    const allUnits = ownUnits.slice();
    const unitChildren = [];
    const seriesChildren = [];
    const groupChildren = [];
    for (const child of childNodes) {
      if (isUnit(child)) {
        unitChildren.push(child);
        allUnits.push(child);
      } else if (child.kind === 'series') {
        seriesChildren.push(child);
        if (flatten) allUnits.push(...child.units);
      } else {
        groupChildren.push(child);
      }
    }

    // Every immediate child is a readable volume -> this folder is a series.
    if (allUnits.length >= 2 && seriesChildren.length === 0 && groupChildren.length === 0) {
      return this.makeSeries(dirAbs, name, allUnits, await util.statOrNull(dirAbs));
    }
    if (flatten && allUnits.length >= 2) {
      return this.makeSeries(dirAbs, name, allUnits, await util.statOrNull(dirAbs));
    }

    const children = groupChildren.concat(seriesChildren, unitChildren, ownUnits);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return this.makeGroup(dirAbs, name, children, await util.statOrNull(dirAbs));
  }

  tryReuse(dirAbs, ctx) {
    if (!ctx.reuseEnabled) return undefined;
    if (ctx.dirty && ctx.dirty.has(dirAbs)) return undefined;
    const prev = ctx.prevDirs.get(dirAbs);
    if (!prev || prev.node == null) return undefined;
    ctx.reused++;
    return prev.node;
  }

  makeFileUnit(fullPath, name, st) {
    const ext = util.extname(name);
    const kind = kindForExt(ext, this.config) || 'book';
    return {
      kind,
      id: util.idFor(fullPath),
      name,
      title: util.cleanTitle(name),
      path: fullPath,
      ext,
      size: st ? st.size : null,
      mtimeMs: st ? st.mtimeMs : null,
    };
  }

  makeImageDirUnit(dirAbs, imageFiles, st) {
    const name = path.basename(dirAbs) || dirAbs;
    const sorted = imageFiles.slice().sort(util.naturalCompare);
    return {
      kind: 'imageDir',
      id: util.idFor(dirAbs),
      name,
      title: util.cleanTitle(name),
      path: dirAbs,
      ext: '',
      size: null,
      mtimeMs: st ? st.mtimeMs : null,
      dirMtimeMs: st ? st.mtimeMs : null,
      chainDirs: [],
      firstPage: sorted[0],
      pageCount: sorted.length,
    };
  }

  makeSeries(dirAbs, name, units, st) {
    const seen = new Set();
    const unique = [];
    for (const u of units) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      unique.push(u);
    }
    unique.sort((a, b) => util.compareVolumes(a.title || a.name, b.title || b.name));
    const parsed = util.parseName(name);
    return {
      kind: 'series',
      id: util.idFor('series:' + dirAbs),
      name,
      title: parsed.title,
      note: parsed.note || '',
      path: dirAbs,
      mtimeMs: st ? st.mtimeMs : null,
      units: unique,
    };
  }

  makeGroup(dirAbs, name, children, st) {
    const parsed = util.parseName(name);
    return {
      kind: 'group',
      id: util.idFor('group:' + dirAbs),
      name,
      title: parsed.title,
      note: parsed.note || '',
      path: dirAbs,
      mtimeMs: st ? st.mtimeMs : null,
      children: sortChildren(children),
    };
  }

  /** Every node object in the persisted tree (used to build reuse lookups). */
  *walkTreeNodes() {
    const stack = [...this.tree.roots];
    while (stack.length) {
      const node = stack.pop();
      yield node;
      if (node.children) stack.push(...node.children);
      if (node.units) stack.push(...node.units);
    }
  }

  // ------------------------------------------------------------- finalizing

  /**
   * Rebuild the flat lookup maps, (re)assign ancestry/order metadata and drop
   * anything that ended up with no readable content. Cheap: no filesystem work.
   */
  finalize() {
    this.units = new Map();
    this.series = new Map();
    this.nodes = new Map();

    const visit = (node, parent, rootName, trail) => {
      node.parentId = parent ? parent.id : null;
      if (isUnit(node)) {
        node.rootName = rootName;
        node.groupPath = trail.slice();
        node.unitCount = 1;
        node.seriesCount = 0;
        return node;
      }
      if (node.kind === 'series') {
        const units = [];
        for (const u of node.units || []) {
          if (!u || !u.path) continue;
          const unit = u;
          unit.rootName = rootName;
          unit.groupPath = trail.slice();
          unit.seriesId = node.id;
          unit.seriesTitle = node.title || node.name;
          unit.seriesPath = node.path;
          units.push(unit);
        }
        if (units.length === 0) return null;
        units.sort((a, b) => util.compareVolumes(a.title || a.name, b.title || b.name));
        units.forEach((u, i) => {
          u.ordinal = i + 1;
        });
        node.units = units;
        node.unitCount = units.length;
        node.seriesCount = 1;
        node.rootName = rootName;
        node.groupPath = trail.slice();
        node.size = units.every((u) => u.size == null) ? null : units.reduce((s, u) => s + (u.size || 0), 0);
        node.coverUnitId = (units.find((u) => u.kind !== 'book') || units[0]).id;
        this.series.set(node.id, node);
        this.nodes.set(node.id, node);
        for (const u of units) {
          this.units.set(u.id, u);
          this.nodes.set(u.id, u);
        }
        return node;
      }
      if (node.kind === 'group' || node.kind === 'root') {
        const children = [];
        for (const child of node.children || []) {
          const kept = visit(child, node, rootName, node.kind === 'root' ? trail : trail.concat(node.title || node.name));
          if (kept) children.push(kept);
        }
        if (children.length === 0) return null;
        node.children = sortChildren(children);
        node.childCount = children.length;
        node.unitCount = children.reduce((n, c) => n + (c.unitCount || 0), 0);
        node.seriesCount = children.reduce((n, c) => n + (c.seriesCount || 0), 0);
        if (node.kind === 'group') {
          node.rootName = rootName;
          node.groupPath = trail.slice();
          node.size = children.every((c) => c.size == null) ? null : children.reduce((s, c) => s + (c.size || 0), 0);
        }
        this.nodes.set(node.id, node);
        return node;
      }
      return null;
    };

    const roots = [];
    for (const root of this.tree.roots || []) {
      const children = [];
      for (const child of root.children || []) {
        const kept = visit(child, root, root.name || root.title, []);
        if (kept) children.push(kept);
      }
      if (children.length === 0) continue;
      root.children = sortChildren(children);
      root.rootName = root.name;
      root.unitCount = children.reduce((n, c) => n + (c.unitCount || 0), 0);
      root.seriesCount = children.reduce((n, c) => n + (c.seriesCount || 0), 0);
      this.nodes.set(root.id, root);
      roots.push(root);
    }
    this.tree.roots = roots;
    this.tree.version = INDEX_VERSION;
  }

  // -------------------------------------------------------------- lookups

  unitById(id) {
    return this.units.get(id) || null;
  }

  seriesById(id) {
    return this.series.get(id) || null;
  }

  nodeById(id) {
    return this.nodes.get(id) || null;
  }

  /** Fill in missing file sizes/pages for one series (lazy, cached in index). */
  async enrichSeries(series) {
    if (!series) return series;
    let changed = false;
    const missing = series.units.filter((u) => u.size == null && u.kind !== 'imageDir');
    if (missing.length) {
      await util.mapLimit(missing, 16, async (u) => {
        const st = await util.statOrNull(u.path);
        if (st) {
          u.size = st.size;
          u.mtimeMs = st.mtimeMs;
          changed = true;
        }
      });
      if (changed) {
        series.size = series.units.every((u) => u.size == null)
          ? null
          : series.units.reduce((s, u) => s + (u.size || 0), 0);
        this.save();
      }
    }
    return series;
  }
}

module.exports = { Library, isUnit, unitKinds: UNIT_KINDS, INDEX_VERSION };
