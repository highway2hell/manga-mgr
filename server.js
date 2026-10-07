'use strict';

/**
 * manga-mgr — a tiny self-hosted manga wall.
 *
 * Scans local/NAS comic folders (PDF, ZIP/RAR/7z, MOBI, EPUB, image folders),
 * serves a browsable cover grid and reads every supported format in the
 * browser. No database, no build step: Node + Express + plain frontend.
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('./lib/util');
const configModule = require('./lib/config');
const { Library } = require('./lib/scanner');
const { PageStore } = require('./lib/pages');
const { CoverStore } = require('./lib/covers');
const { ProgressStore } = require('./lib/progress');
const tools = require('./lib/tools');

const ROOT = __dirname;
const config = configModule.load();

const app = express();
app.use(express.json({ limit: '256kb' }));

const library = new Library(config);
const progress = new ProgressStore(config);
const pages = new PageStore(config, library, broadcast);
const covers = new CoverStore(config, library, pages, broadcast);

// ------------------------------------------------------------------ events

const clients = new Set();
let coverBatch = [];
let coverBatchTimer = null;

function broadcast(event) {
  if (event && event.type === 'cover') {
    coverBatch.push(event.id);
    if (!coverBatchTimer) {
      coverBatchTimer = setTimeout(() => {
        coverBatchTimer = null;
        const ids = coverBatch;
        coverBatch = [];
        send({ type: 'covers', ids });
      }, 400);
      if (coverBatchTimer.unref) coverBatchTimer.unref();
    }
    return;
  }
  send(event);
}

function send(event) {
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  res.write('data: ' + JSON.stringify({ type: 'hello', stats: library.stats, scan: library.state }) + '\n\n');
  clients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ---------------------------------------------------------------- summaries

function pathLabel(p) {
  const roots = config.libraryDirs.map((d) => d.path);
  for (const root of roots) {
    if (util.isInside(root, p)) {
      const rel = path.relative(root, p);
      return rel || path.basename(root);
    }
  }
  return p;
}

function groupAggregates(node) {
  let unitCount = 0;
  let seriesCount = 0;
  for (const child of node.children || []) {
    if (child.kind === 'series') {
      seriesCount += 1;
      unitCount += child.unitCount || child.units.length;
    } else if (child.kind === 'group' || child.kind === 'root') {
      unitCount += child.unitCount || 0;
      seriesCount += child.seriesCount || 0;
    } else {
      unitCount += 1;
    }
  }
  return { unitCount, seriesCount };
}

/** The volume whose picture represents this node. */
function coverIdFor(node) {
  if (node.kind === 'series') return node.coverUnitId || node.id;
  if (node.kind === 'group' || node.kind === 'root') {
    const stack = [...(node.children || [])];
    let guard = 0;
    while (stack.length && guard++ < 500) {
      const child = stack.shift();
      if (child.kind === 'series') return child.coverUnitId || child.id;
      if (child.kind === 'group') stack.push(...(child.children || []));
      else return child.id;
    }
    return node.id;
  }
  return node.id;
}

function summarize(node) {
  if (!node) return null;
  if (node.kind === 'series') {
    const summary = progress.seriesSummary(node.units.map((u) => u.id));
    return {
      type: 'series',
      id: node.id,
      kind: 'series',
      title: node.title || node.name,
      note: node.note || '',
      path: node.path,
      rel: pathLabel(node.path),
      unitCount: node.unitCount || node.units.length,
      size: node.size,
      coverId: coverIdFor(node),
      coverUrl: '/api/cover/' + coverIdFor(node),
      coverUnitId: node.coverUnitId,
      groupPath: node.groupPath || [],
      rootName: node.rootName || '',
      mtimeMs: node.mtimeMs || 0,
      read: summary.read,
      lastPage: summary.last ? summary.last.page : null,
      lastTotal: summary.last ? summary.last.total : null,
      formats: countFormats(node.units),
    };
  }
  if (node.kind === 'group' || node.kind === 'root') {
    const agg = groupAggregates(node);
    return {
      type: 'group',
      kind: node.kind,
      id: node.id,
      title: node.title || node.name,
      note: node.note || '',
      path: node.path,
      rel: pathLabel(node.path),
      childCount: (node.children || []).length,
      unitCount: agg.unitCount,
      seriesCount: agg.seriesCount,
      size: node.size,
      coverId: coverIdFor(node),
      coverUrl: '/api/cover/' + coverIdFor(node),
      groupPath: node.groupPath || [],
      rootName: node.rootName || '',
      mtimeMs: node.mtimeMs || 0,
      formats: countFormatsDeep(node),
    };
  }
  // A volume that sits directly at library level (no series around it).
  return {
    type: 'volume',
    id: node.id,
    title: node.title || node.name,
    format: node.kind,
    size: node.size,
    path: node.path,
    rel: pathLabel(node.path),
    coverId: node.id,
    coverUrl: '/api/cover/' + node.id,
    groupPath: node.groupPath || [],
    rootName: node.rootName || '',
    mtimeMs: node.mtimeMs || 0,
    pageCount: pages.cachedPageCount(node),
    progress: progress.get(node.id),
  };
}

function countFormats(units) {
  const out = {};
  for (const u of units || []) out[u.kind] = (out[u.kind] || 0) + 1;
  return out;
}

function countFormatsDeep(node) {
  const out = {};
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.kind === 'series') {
      for (const u of n.units) out[u.kind] = (out[u.kind] || 0) + 1;
    } else if (n.children) {
      stack.push(...n.children);
    } else if (n.path && n.kind) {
      out[n.kind] = (out[n.kind] || 0) + 1;
    }
  }
  return out;
}

function summarizeUnit(unit) {
  return {
    type: 'volume',
    id: unit.id,
    title: unit.title || unit.name,
    name: unit.name,
    format: unit.kind,
    ext: unit.ext || '',
    size: unit.size,
    path: unit.path,
    rel: pathLabel(unit.path),
    ordinal: unit.ordinal || null,
    seriesId: unit.seriesId || null,
    coverId: unit.id,
    coverUrl: '/api/cover/' + unit.id,
    mtimeMs: unit.mtimeMs || 0,
    pageCount: pages.cachedPageCount(unit),
    progress: progress.get(unit.id),
  };
}

function breadcrumbFor(node) {
  const out = [];
  let current = node;
  while (current && current.parentId) {
    const parent = library.nodeById(current.parentId);
    if (!parent) break;
    out.unshift({ id: parent.id, title: parent.title || parent.name, type: parent.kind });
    current = parent;
  }
  return out;
}

// ------------------------------------------------------------------- routes

app.get('/api/config', (req, res) => {
  res.json({
    libraryDirs: config.libraryDirs.map((d) => ({ name: d.name, path: d.path, exists: fs.existsSync(d.path) })),
    platform: process.platform,
    tools: tools.capabilities(),
    coverWidth: config.coverWidth,
    cacheLimitGB: config.cacheLimitGB,
    scanOnStart: config.scanOnStart,
    formats: {
      archive: config.archiveExtensions,
      book: config.bookExtensions,
      image: config.imageExtensions,
    },
  });
});

app.get('/api/stats', (req, res) => {
  res.json({ stats: library.stats, scan: library.state, scannedAt: library.scannedAt, errors: library.scanErrors.slice(0, 20) });
});

app.get('/api/library', (req, res) => {
  res.json({
    stats: library.stats,
    scannedAt: library.scannedAt,
    scan: library.state,
    errors: library.scanErrors.slice(0, 10),
    roots: library.tree.roots.map((root) => ({
      type: 'group',
      id: root.id,
      kind: 'root',
      title: root.title || root.name,
      path: root.path,
      rel: pathLabel(root.path),
      childCount: (root.children || []).length,
      unitCount: root.unitCount || 0,
      seriesCount: root.seriesCount || 0,
      coverId: coverIdFor(root),
      coverUrl: '/api/cover/' + coverIdFor(root),
      children: (root.children || []).map(summarize),
    })),
  });
});

app.get('/api/all', (req, res) => {
  const series = [];
  for (const s of library.series.values()) series.push(summarize(s));
  const volumes = [];
  for (const u of library.units.values()) if (!u.seriesId) volumes.push(summarize(u));
  res.json({ series, volumes, stats: library.stats, scannedAt: library.scannedAt, scan: library.state, errors: library.scanErrors.slice(0, 10) });
});

app.get('/api/node/:id', async (req, res) => {
  const node = library.nodeById(req.params.id);
  if (!node) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (node.kind === 'series') await library.enrichSeries(node);
  const payload = {
    node: summarize(node),
    breadcrumb: breadcrumbFor(node),
  };
  if (node.kind === 'group' || node.kind === 'root') {
    payload.children = (node.children || []).map(summarize);
  } else if (node.kind === 'series') {
    payload.units = node.units.map(summarizeUnit);
    payload.series = payload.node;
  } else {
    payload.unit = summarizeUnit(node);
  }
  res.json(payload);
});

app.get('/api/unit/:id', async (req, res) => {
  const unit = library.unitById(req.params.id);
  if (!unit) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const series = unit.seriesId ? library.seriesById(unit.seriesId) : null;
  const siblings = series ? series.units : [unit];
  const index = siblings.findIndex((u) => u.id === unit.id);
  if (series) await library.enrichSeries(series);
  res.json({
    unit: summarizeUnit(unit),
    series: series
      ? {
          id: series.id,
          title: series.title,
          unitCount: series.unitCount,
          coverUrl: '/api/cover/' + series.id,
          groupPath: series.groupPath,
        }
      : null,
    breadcrumb: breadcrumbFor(series || unit),
    prev: index > 0 ? summarizeUnit(siblings[index - 1]) : null,
    next: index >= 0 && index < siblings.length - 1 ? summarizeUnit(siblings[index + 1]) : null,
    siblings: siblings.map((u) => ({ id: u.id, title: u.title, ordinal: u.ordinal })),
  });
});

app.get('/api/pages/:id', (req, res) => {
  const unit = library.unitById(req.params.id);
  if (!unit) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const start = req.query.start !== '0';
  const desc = pages.describe(unit, { start });
  res.json(desc);
});

app.post('/api/pages/:id/count', (req, res) => {
  const unit = library.unitById(req.params.id);
  if (!unit) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const count = Number(req.body && req.body.pageCount);
  if (Number.isFinite(count) && count > 0) pages.setPageCount(unit.id, count);
  res.json({ ok: true });
});

app.get('/api/page/:id/:index', (req, res) => {
  const unit = library.unitById(req.params.id);
  if (!unit) {
    res.status(404).send('Not found');
    return;
  }
  const index = parseInt(req.params.index, 10);
  const file = pages.pageFile(unit, index);
  if (!file) {
    const desc = pages.describe(unit, { start: true });
    res.status(desc.status === 'running' ? 409 : 404).json({ error: 'Page not ready', status: desc.status, progress: desc.progress || null });
    return;
  }
  res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=86400' } }, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

function streamFile(req, res, unit, { download = false } = {}) {
  let size;
  try {
    size = fs.statSync(unit.path).size;
  } catch (err) {
    res.status(404).send('File missing');
    return;
  }
  const mime =
    unit.kind === 'pdf'
      ? 'application/pdf'
      : unit.kind === 'mobi'
      ? 'application/x-mobipocket-ebook'
      : unit.kind === 'epub'
      ? 'application/epub+zip'
      : unit.ext === '.zip' || unit.ext === '.cbz'
      ? 'application/zip'
      : unit.ext === '.rar' || unit.ext === '.cbr'
      ? 'application/vnd.rar'
      : 'application/octet-stream';

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=600',
  };
  if (download) {
    headers['Content-Disposition'] = 'attachment; filename="' + encodeURIComponent(unit.name) + '"';
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.status(416).set('Content-Range', 'bytes */' + size).send('Invalid range');
      return;
    }
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : size - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= size) {
      res.status(416).set('Content-Range', 'bytes */' + size).send('Invalid range');
      return;
    }
    if (end >= size) end = size - 1;
    res.writeHead(206, Object.assign({}, headers, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': end - start + 1,
    }));
    const stream = fs.createReadStream(unit.path, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, Object.assign({}, headers, { 'Content-Length': size }));
  const stream = fs.createReadStream(unit.path);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

app.get('/api/file/:id', (req, res) => {
  const unit = library.unitById(req.params.id);
  if (!unit) {
    res.status(404).send('Not found');
    return;
  }
  streamFile(req, res, unit);
});

app.get('/api/download/:id', (req, res) => {
  const unit = library.unitById(req.params.id);
  if (!unit) {
    res.status(404).send('Not found');
    return;
  }
  if (unit.kind === 'imageDir') {
    res.status(400).send('Folder volumes have no single file to download');
    return;
  }
  streamFile(req, res, unit, { download: true });
});

app.get('/api/cover/:id', async (req, res) => {
  const id = req.params.id;
  const wantWait = req.query.wait === '1';
  if (!covers.has(id)) {
    const file = await covers.get(id, { wait: wantWait, timeout: wantWait ? 30000 : 0 });
    if (!file) {
      res.status(404).json({ error: 'Cover not ready', id });
      return;
    }
  }
  const file = covers.fileFor(id);
  res.sendFile(file, { headers: { 'Cache-Control': 'public, max-age=604800' } }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/covers/status', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 300);
  res.json(covers.status(ids));
});

app.post('/api/covers/pregen', (req, res) => {
  res.json(covers.startPregen());
});

app.post('/api/covers/pregen/stop', (req, res) => {
  covers.stopPregen();
  res.json(covers.pregen);
});

app.get('/api/covers/pregen', (req, res) => {
  res.json(covers.pregen);
});

app.post('/api/scan', async (req, res) => {
  if (library.state.running) {
    res.status(202).json({ status: 'already-running', scan: library.state });
    return;
  }
  const force = !(req.body && req.body.force === false);
  res.status(202).json({ status: 'started', force });
  send({ type: 'scan', phase: 'start', force });
  library
    .scan({
      force,
      onProgress: (p) => send({ type: 'scan', phase: 'walk', ...p }),
    })
    .then(() => {
      const purged = safeRun(() => pages.cleanScratch()) + safeRun(() => pages.purgeStale());
      const purgedCovers = safeRun(() => covers.purgeStale());
      send({ type: 'scan', phase: 'done', stats: library.stats, purged, purgedCovers, ...library.state });
    })
    .catch((err) => send({ type: 'scan', phase: 'error', error: err.message }));
});

function safeRun(fn) {
  try {
    return fn();
  } catch {
    return 0;
  }
}

app.get('/api/scan/status', (req, res) => {
  res.json({ scan: library.state, stats: library.stats, scannedAt: library.scannedAt, errors: library.scanErrors.slice(0, 20) });
});

app.get('/api/progress', (req, res) => {
  res.json({ items: progress.data.items, favorites: progress.favorites() });
});

app.post('/api/progress', (req, res) => {
  const body = req.body || {};
  const unitId = String(body.unitId || '');
  const unit = library.unitById(unitId);
  if (!unit) {
    res.status(404).json({ error: 'Unknown unit' });
    return;
  }
  const patch = {
    page: Number.isFinite(Number(body.page)) ? Number(body.page) : 0,
    total: Number.isFinite(Number(body.total)) ? Number(body.total) : null,
    title: unit.title,
    seriesId: unit.seriesId || null,
    seriesTitle: unit.seriesTitle || null,
    format: unit.kind,
    ordinal: unit.ordinal || null,
  };
  const saved = progress.set(unitId, patch);
  res.json({ ok: true, item: saved });
});

app.post('/api/favorite', (req, res) => {
  const body = req.body || {};
  const id = String(body.id || '');
  if (!library.nodeById(id)) {
    res.status(404).json({ error: 'Unknown id' });
    return;
  }
  const node = library.nodeById(id);
  const meta =
    body.favorite === false
      ? false
      : {
          title: node.title || node.name,
          type: node.kind === 'series' ? 'series' : library.unitById(id) ? 'volume' : 'group',
          coverUrl: '/api/cover/' + id,
          seriesId: node.seriesId || null,
          unitCount: node.unitCount || null,
        };
  const result = progress.favorite(id, meta);
  res.json({ ok: true, favorite: result, isFavorite: progress.isFavorite(id) });
});

app.get('/api/continue', (req, res) => {
  const items = progress.recent(40);
  const out = [];
  for (const item of items) {
    const unit = library.unitById(item.unitId);
    if (!unit) continue;
    out.push({
      unit: summarizeUnit(unit),
      progress: item,
      series: item.seriesId ? { id: item.seriesId, title: item.seriesTitle, coverUrl: '/api/cover/' + item.seriesId } : null,
    });
    if (out.length >= 20) break;
  }
  res.json({ items: out, favorites: progress.favorites() });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 1) {
    res.json({ results: [] });
    return;
  }
  const results = [];
  for (const series of library.series.values()) {
    if ((series.title + ' ' + series.name + ' ' + (series.groupPath || []).join(' ')).toLowerCase().includes(q)) {
      results.push(summarize(series));
    }
    if (results.length > 200) break;
  }
  for (const unit of library.units.values()) {
    if (results.length > 300) break;
    if (unit.seriesId && library.seriesById(unit.seriesId) && library.seriesById(unit.seriesId).title.toLowerCase().includes(q)) continue;
    if ((unit.title + ' ' + unit.name).toLowerCase().includes(q)) results.push(summarize(unit));
  }
  results.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'));
  res.json({ results: results.slice(0, 300), query: q });
});

// pdf.js (served straight from node_modules; no bundler involved)
app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '1h' }));

// The app shell is always revalidated: editing files here takes effect on the
// next reload (the library itself is what the caches are for).
app.use(express.static(path.join(ROOT, 'public'), { etag: false, maxAge: 0, cacheControl: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
    return;
  }
  next();
});

// ------------------------------------------------------------------ startup

// Stay up through stray I/O errors (a NAS hiccup should not take the library
// offline); systemd restarts the service if something truly fatal happens.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running): ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept running): ' + (err && err.stack ? err.stack : err));
});

async function startup() {
  const hadIndex = library.load();
  console.log(hadIndex ? 'Loaded cached index: ' + JSON.stringify(library.stats) : 'No cached index yet.');

  const caps = tools.capabilities();
  for (const line of tools.describe()) console.log('  ' + line);
  if (!caps.rar) {
    console.warn('  ! RAR/7z volumes will not be readable: install libarchive-tools / p7zip-full,');
    console.warn('    or place a 7-Zip binary at ' + path.join(ROOT, 'bin', '7zz'));
  }

  const server = app.listen(config.port, config.host, () => {
    console.log('Manga Wall running at http://' + (config.host === '0.0.0.0' ? 'localhost' : config.host) + ':' + config.port);
    console.log('Libraries:');
    for (const d of config.libraryDirs) console.log('  - ' + d.name + ' (' + d.path + ')');
    if (hadIndex) console.log('Catalog: ' + library.stats.series + ' series / ' + library.stats.units + ' volumes.');
  });
  server.on('error', (err) => {
    console.error('Failed to start on port ' + config.port + ': ' + err.message);
    process.exit(1);
  });

  if (config.scanOnStart) {
    if (!hadIndex) console.log('First run: scanning the library (this can take a minute on a NAS)...');
    library
      .scan({ force: !hadIndex, onProgress: (p) => send({ type: 'scan', phase: 'walk', ...p }) })
      .then(() => {
        safeRun(() => pages.cleanScratch());
        safeRun(() => pages.purgeStale());
        safeRun(() => covers.purgeStale());
        console.log('Scan finished: ' + JSON.stringify(library.stats));
        send({ type: 'scan', phase: 'done', stats: library.stats, ...library.state });
      })
      .catch((err) => console.error('Scan failed: ' + err.message));
  }
}

startup();

module.exports = { app, library, covers, pages };
