/* manga-mgr frontend — no build step, plain ES module + pdf.js from /vendor. */

const $ = (sel, root = document) => root.querySelector(sel);
const appEl = $('#app');
const readerEl = $('#reader');

const state = {
  cfg: null,
  lib: null,
  view: { name: 'home' },
  sort: 'added',
  filter: 'all',
  status: 'all',
  cardW: 158,
  expanded: new Set(),
  lastRead: null,
};

/* ------------------------------------------------------------------ helpers */

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.clone().json()).error || '';
    } catch { /* not json */ }
    const err = new Error(detail || res.status + ' ' + res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
}

function fmtAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const day = 86400000;
  if (diff < 3600000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前';
  if (diff < day) return Math.round(diff / 3600000) + ' 小时前';
  if (diff < day * 30) return Math.round(diff / day) + ' 天前';
  return new Date(ms).toLocaleDateString('zh-CN');
}

function toast(message, kind = '') {
  const node = el('div', { class: 'toast ' + kind, text: message });
  $('#toast').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 320);
  }, kind === 'err' ? 5200 : 2600);
}

const FORMAT_LABEL = { pdf: 'PDF', archive: '压缩包', mobi: 'MOBI', epub: 'EPUB', imageDir: '图片', book: '文件' };

/* ------------------------------------------------------------------- covers */

const covers = {
  pending: new Map(),
  observed: new Set(),
  timer: null,
  observer: null,

  /** Only cards scrolled into view ask the server for a cover. */
  watch() {
    if (this.observer || typeof IntersectionObserver === 'undefined') return this.observer;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        this.observer.unobserve(img);
        this.observed.delete(img);
        this.load(img);
      }
    }, { rootMargin: '400px 0px' });
    return this.observer;
  },

  attach(id, img, coverBox, opts = {}) {
    img.dataset.cover = id;
    img._coverBox = coverBox;
    if (opts.eager) {
      this.load(img, opts.wait);
      return;
    }
    const observer = this.watch();
    if (observer) {
      this.observed.add(img);
      observer.observe(img);
    } else {
      this.load(img);
    }
  },

  load(img, wait) {
    const id = img.dataset.cover;
    if (!id) return;
    img.addEventListener('load', () => {
      img.classList.add('ready');
      if (img._coverBox) img._coverBox.classList.remove('pending');
    });
    img.addEventListener('error', () => {
      img.classList.remove('ready');
      if (img._coverBox) img._coverBox.classList.add('pending');
      this.pending.set(id, { img, box: img._coverBox });
      this.start();
    });
    img.src = '/api/cover/' + id + (wait ? '?wait=1' : '');
  },

  ready(id, version) {
    const entry = this.pending.get(id);
    if (!entry) return;
    const img = entry.img;
    img.src = '/api/cover/' + id + (version ? '?v=' + version : '?v=' + Date.now());
    img.classList.add('ready');
    if (entry.box) entry.box.classList.remove('pending');
    this.pending.delete(id);
  },

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), 1500);
  },

  async poll() {
    // Forget cards that were re-rendered away.
    if (this.observer) {
      for (const img of [...this.observed]) {
        if (!img.isConnected) {
          this.observer.unobserve(img);
          this.observed.delete(img);
        }
      }
    }
    if (!this.pending.size) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    const ids = [...this.pending.keys()].slice(0, 200);
    try {
      const res = await api('/api/covers/status?ids=' + ids.join(','));
      for (const item of res.ready) this.ready(item.id, item.version);
      // Give up on the ones the server cannot produce (no more polling).
      for (const id of [...(res.missing || []), ...(res.failed || [])]) {
        const entry = this.pending.get(id);
        if (entry && entry.box) entry.box.classList.add('nofix');
        this.pending.delete(id);
      }
    } catch { /* keep trying */ }
  },
};

function coverBox(item, opts = {}) {
  const img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
  const glyph = (item.title || '?').trim().slice(0, 1) || '?';
  const ph = el('div', { class: 'ph' },
    el('div', { class: 'glyph', text: opts.group ? '▤' : glyph }),
    el('div', { text: opts.group ? (item.seriesCount || 0) + ' 部作品' : FORMAT_LABEL[item.format] || '' })
  );
  const box = el('div', { class: 'cover' }, img, ph);
  const coverId = item.coverId || item.id;
  if (item.coverUrl) covers.attach(coverId, img, box);
  return box;
}

/* -------------------------------------------------------------------- cards */

function cardFor(item, opts = {}) {
  const isGroup = item.type === 'group';
  const card = el('div', { class: 'card' + (isGroup ? ' group' : ''), onclick: () => openItem(item) });
  const box = coverBox(item, { group: isGroup });

  if (isGroup) {
    box.append(el('div', { class: 'badge-tr', text: (item.unitCount || 0) + ' 卷' }));
    box.append(el('div', { class: 'badge-tl', text: '分组' }));
  } else if (item.type === 'series') {
    box.append(el('div', { class: 'badge-tr', text: (item.unitCount || 0) + ' 卷' }));
    const formats = Object.keys(item.formats || {});
    if (formats.length) box.append(el('div', { class: 'badge-tl', text: FORMAT_LABEL[formats[0]] || '' }));
    if (item.read) {
      const pct = Math.min(100, Math.round((item.read / Math.max(1, item.unitCount)) * 100));
      box.append(el('div', { class: 'prog' }, el('i', { style: { width: pct + '%' } })));
    }
  } else {
    box.append(el('div', { class: 'badge-tl', text: FORMAT_LABEL[item.format] || '' }));
    const pr = item.progress;
    if (pr && pr.total) {
      const pct = Math.min(100, Math.round(((pr.page + 1) / pr.total) * 100));
      box.append(el('div', { class: 'badge-tr', text: pct + '%' }));
      box.append(el('div', { class: 'prog' }, el('i', { style: { width: pct + '%' } })));
    }
  }

  card.append(box, el('div', { class: 'name', text: item.title || '' }));
  const subs = [];
  if (isGroup) subs.push((item.seriesCount || 0) + ' 部作品');
  if (item.note) subs.push(item.note);
  if (item.size) subs.push(fmtSize(item.size));
  if (!isGroup && item.type === 'volume' && item.pageCount) subs.push(item.pageCount + ' 页');
  card.append(el('div', { class: 'sub', text: subs.filter(Boolean).join(' · ') }));
  return card;
}

function openItem(item) {
  if (item.type === 'group') location.hash = '#/n/' + item.id;
  else if (item.type === 'series') location.hash = '#/s/' + item.id;
  else location.hash = '#/r/' + item.id;
}

/* ------------------------------------------------------------------- sorting */

function sortItems(items, sort) {
  const arr = items.slice();
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  switch (sort) {
    case 'added':
      arr.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
      break;
    case 'volumes':
      arr.sort((a, b) => (b.unitCount || 0) - (a.unitCount || 0));
      break;
    case 'size':
      arr.sort((a, b) => (b.size || 0) - (a.size || 0));
      break;
    case 'progress':
      arr.sort((a, b) => progressRatio(b) - progressRatio(a));
      break;
    default:
      arr.sort((a, b) => collator.compare(a.title || '', b.title || ''));
  }
  return arr;
}

function progressRatio(item) {
  if (item.type === 'series') return item.read ? (item.read / Math.max(1, item.unitCount)) * 0.5 + 0.5 : 0;
  const pr = item.progress;
  if (!pr || !pr.total) return 0;
  return Math.min(1, (pr.page + 1) / pr.total);
}

function filterItems(items) {
  let out = items;
  if (state.filter !== 'all') out = out.filter((i) => (i.formats ? i.formats[state.filter] : i.format === state.filter));
  if (state.status !== 'all') {
    out = out.filter((i) => {
      const r = progressRatio(i);
      if (state.status === 'unread') return r === 0;
      if (state.status === 'reading') return r > 0 && r < 1;
      if (state.status === 'done') return r >= 1;
      return true;
    });
  }
  return out;
}

/* --------------------------------------------------------------------- shell */

function buildShell() {
  const search = el('input', {
    type: 'search',
    placeholder: '搜索作品 / 卷 (按 Enter 全库搜索)',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        const q = e.target.value.trim();
        if (q) location.hash = '#/q/' + encodeURIComponent(q);
      }
      e.stopPropagation();
    },
  });
  const topbar = el('div', { class: 'topbar' },
    el('div', { class: 'brand', onclick: () => (location.hash = '#/') },
      el('span', { class: 'dot' }),
      '漫画墙',
      el('small', { text: 'manga-mgr' })
    ),
    el('div', { class: 'search' }, search),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn', text: '重新扫描', title: '重新扫描漫画库 (增量)', onclick: startScan(false) }),
    el('button', { class: 'btn ghost', text: '全量重扫', title: '忽略缓存，完整重新扫描', onclick: () => startScan(true) }),
    el('button', { class: 'btn ghost', text: '预生成封面', title: '后台为所有作品生成封面', onclick: () => api('/api/covers/pregen', { method: 'POST' }).then(() => toast('已开始后台生成封面', 'ok')).catch((e) => toast('失败: ' + e.message, 'err')) })
  );
  const sidebar = el('div', { class: 'sidebar', id: 'sidebar' });
  const content = el('div', { class: 'content', id: 'content' });
  const status = el('div', { class: 'statusline', id: 'statusline' });
  appEl.append(el('div', { class: 'app' }, topbar, el('div', { class: 'body' }, sidebar, content), status));
}

async function startScan(force) {
  try {
    await api('/api/scan', { method: 'POST', body: { force } });
    toast(force ? '已开始全量扫描（会遍历所有目录）' : '已开始增量扫描', 'ok');
  } catch (err) {
    toast('扫描启动失败: ' + err.message, 'err');
  }
}

function renderStatus() {
  const s = $('#statusline');
  const stats = state.lib ? state.lib.stats : null;
  const scan = state.lib ? state.lib.scan : null;
  const parts = [];
  if (stats) {
    parts.push(el('span', { text: '系列 ' + stats.series }));
    parts.push(el('span', { text: '卷 ' + stats.units }));
    if (stats.size) parts.push(el('span', { text: '≈' + fmtSize(stats.size) }));
    parts.push(el('span', { text: '索引 ' + (state.lib.scannedAt ? fmtAgo(state.lib.scannedAt) : '未扫描') }));
  }
  if (scan && scan.running) {
    parts.push(el('span', { class: 'badge accent', text: '扫描中… ' + (scan.visited || 0) + ' 目录 / ' + (scan.units || 0) + ' 卷' }));
    watchScan();
  }
  if (scan && !scan.running && scan.reused) parts.push(el('span', { text: '上次扫描复用 ' + scan.reused + ' 目录，用时 ' + Math.round(((scan.finishedAt || 0) - (scan.startedAt || 0)) / 1000) + 's' }));
  if (state.lib && state.lib.errors && state.lib.errors.length) parts.push(el('span', { class: 'badge warn', text: state.lib.errors.length + ' 个目录无法读取' }));
  if (state.cfg && state.cfg.tools && !state.cfg.tools.rar) {
    parts.push(el('span', { class: 'badge warn', title: '缺少 bsdtar / 7z，RAR、CBR、7z 卷暂时无法阅读（ZIP、PDF、MOBI 不受影响）', text: 'RAR/7z 不可读：缺少解压工具' }));
  }
  s.replaceChildren(...parts);
}

// If the page is loaded while a scan is running, the SSE "done" event may be
// missed entirely — so keep asking until the server says it stopped.
let scanWatchTimer = null;
function watchScan() {
  if (scanWatchTimer) return;
  scanWatchTimer = setInterval(async () => {
    try {
      const status = await api('/api/scan/status');
      if (state.lib) Object.assign(state.lib, { scan: status.scan, stats: status.stats, scannedAt: status.scannedAt });
      renderStatus();
      if (!status.scan.running) {
        clearInterval(scanWatchTimer);
        scanWatchTimer = null;
        ensureLibrary(true).then(() => {
          renderSidebar();
          render();
        });
      }
    } catch {
      clearInterval(scanWatchTimer);
      scanWatchTimer = null;
    }
  }, 3000);
}

function renderSidebar() {
  const sidebar = $('#sidebar');
  sidebar.replaceChildren();
  if (!state.lib) return;
  sidebar.append(el('h4', { text: '书库' }));
  for (const root of state.lib.roots) {
    sidebar.append(treeRow(root, 0, true));
    if (state.expanded.has(root.id)) {
      const kids = el('div', { class: 'tree-children' });
      for (const child of root.children || []) kids.append(treeRow(child, 1, true));
      sidebar.append(kids);
    }
  }
  sidebar.append(el('h4', { text: '快捷' }));
  sidebar.append(treeRow({ id: '__home', type: 'group', title: '全部作品', unitCount: state.lib.stats.units }, 0, false, () => (location.hash = '#/')));
  sidebar.append(treeRow({ id: '__continue', type: 'group', title: '继续阅读' }, 0, false, () => (location.hash = '#/continue')));
  sidebar.append(treeRow({ id: '__fav', type: 'group', title: '收藏' }, 0, false, () => (location.hash = '#/fav')));
}

function treeRow(node, depth, allowExpand, onClick) {
  const active = state.view.id === node.id;
  const isGroup = node.type === 'group' || node.kind === 'group' || node.kind === 'root';
  const expandable = allowExpand && isGroup && (node.childCount || 0) > 0;
  const twisty = el('span', { class: 'twisty', text: expandable ? (state.expanded.has(node.id) ? '▾' : '▸') : '' });
  const row = el('div', { class: 'tree-item' + (active ? ' active' : ''), title: node.title },
    twisty,
    el('span', { class: 'label', text: node.title || '' }),
    el('span', { class: 'count', text: node.unitCount ? String(node.unitCount) : '' })
  );
  row.addEventListener('click', (e) => {
    if (expandable && (e.target === twisty || e.altKey)) {
      if (state.expanded.has(node.id)) state.expanded.delete(node.id);
      else state.expanded.add(node.id);
      renderSidebar();
      return;
    }
    if (onClick) onClick();
    else if (isGroup) location.hash = '#/n/' + node.id;
    else location.hash = '#/s/' + node.id;
    if (expandable && !state.expanded.has(node.id)) {
      state.expanded.add(node.id);
      renderSidebar();
    }
  });
  return row;
}

/* -------------------------------------------------------------------- router */

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = hash.split('/');
  closeReaderIfOpen(hash);
  try {
    if (head === 'r') {
      const id = rest[0];
      state.view = { name: 'reader', id };
      await reader.open(id);
      return;
    }
    if (head === 's') return await viewSeries(rest.join('/'));
    if (head === 'n') return await viewNode(decodeURIComponent(rest.join('/')));
    if (head === 'q') return await viewSearch(decodeURIComponent(rest.join('/')));
    if (head === 'continue') return await viewContinue();
    if (head === 'fav') return await viewFavorites();
    return await viewHome();
  } catch (err) {
    $('#content').replaceChildren(el('div', { class: 'empty', text: '出错了: ' + err.message }));
  }
}

function closeReaderIfOpen(hash) {
  if (!hash.startsWith('r/') && !readerEl.classList.contains('hidden')) reader.close();
}

async function ensureLibrary(force) {
  if (!state.lib || force) state.lib = await api('/api/library');
  return state.lib;
}

function crumbs(items) {
  const wrap = el('div', { class: 'crumbs' });
  items.forEach((item, i) => {
    if (i) wrap.append(el('span', { class: 'sep', text: '/' }));
    if (item.hash) wrap.append(el('a', { href: item.hash, text: item.title }));
    else wrap.append(el('span', { text: item.title }));
  });
  return wrap;
}

function toolbar(extra = []) {
  const sort = el('select', {
    onchange: (e) => { state.sort = e.target.value; render(); },
  },
    ...[['added', '最近添加'], ['title', '标题'], ['volumes', '卷数'], ['progress', '阅读进度'], ['size', '大小']].map(([v, t]) =>
      el('option', { value: v, selected: state.sort === v, text: t })));
  const filter = el('select', {
    onchange: (e) => { state.filter = e.target.value; render(); },
  },
    ...[['all', '全部格式'], ['pdf', 'PDF'], ['archive', '压缩包'], ['mobi', 'MOBI'], ['imageDir', '图片文件夹'], ['epub', 'EPUB']].map(([v, t]) =>
      el('option', { value: v, selected: state.filter === v, text: t })));
  const status = el('select', {
    onchange: (e) => { state.status = e.target.value; render(); },
  },
    ...[['all', '全部状态'], ['unread', '未读'], ['reading', '在读'], ['done', '已读完']].map(([v, t]) =>
      el('option', { value: v, selected: state.status === v, text: t })));
  const size = el('input', {
    type: 'range', min: 110, max: 260, value: state.cardW, title: '卡片大小',
    style: { width: '110px' },
    oninput: (e) => {
      state.cardW = Number(e.target.value);
      document.documentElement.style.setProperty('--card-w', state.cardW + 'px');
    },
  });
  return el('div', { class: 'toolbar' }, sort, filter, status, size, ...extra);
}

let pendingRender = null;
function render() {
  if (pendingRender) return;
  pendingRender = requestAnimationFrame(() => {
    pendingRender = null;
    if (state.view.render) state.view.render();
    renderStatus();
  });
}

/* --------------------------------------------------------------------- views */

async function viewHome() {
  await ensureLibrary(true);
  const data = await api('/api/all');
  state.view = {
    name: 'home',
    render: () => {
      const content = $('#content');
      const series = sortItems(filterItems(data.series), state.sort);
      const volumes = sortItems(filterItems(data.volumes), state.sort);
      const nodes = [];
      nodes.push(el('div', { class: 'title-row' }, el('h1', { text: '全部作品' }),
        el('div', { class: 'meta' },
          el('span', { text: series.length + ' 部系列' }),
          el('span', { text: volumes.length + ' 本单行' }),
          el('span', { text: data.stats.units + ' 卷' }),
          state.lib.scannedAt ? el('span', { text: '索引于 ' + fmtAgo(state.lib.scannedAt) }) : null
        )));
      nodes.push(toolbar());
      if (state.lastRead && state.lastRead.items.length) {
        nodes.push(el('div', { class: 'section-title' }, '继续阅读', el('span', { class: 'sub', text: '点击直接跳回上次位置' })));
        nodes.push(el('div', { class: 'grid' }, state.lastRead.items.slice(0, 8).map((it) => cardFor(Object.assign({}, it.unit, { progress: it.progress })))));
      }
      const grid = el('div', { class: 'grid' });
      for (const item of series) grid.append(cardFor(item));
      for (const item of volumes) grid.append(cardFor(item));
      nodes.push(el('div', { class: 'section-title' }, '书库', el('span', { class: 'sub', text: '按分组浏览' })));
      const rootGrid = el('div', { class: 'grid' });
      for (const root of state.lib.roots) for (const child of root.children) rootGrid.append(cardFor(child));
      nodes.push(rootGrid);
      nodes.push(el('div', { class: 'section-title' }, '全部系列', el('span', { class: 'sub', text: series.length + ' 部' })));
      nodes.push(grid);
      if (!series.length && !volumes.length) nodes.push(el('div', { class: 'empty', text: '没有匹配的作品' }));
      content.replaceChildren(...nodes);
    },
  };
  state.view.render();
  renderSidebar();
  renderStatus();
  api('/api/continue').then((d) => {
    state.lastRead = d;
    state.view.render();
  }).catch(() => {});
}

async function viewNode(id) {
  const data = await api('/api/node/' + encodeURIComponent(id));
  const node = data.node;
  const children = data.children || [];
  state.view = {
    id,
    name: 'node',
    render: () => {
      const nodes = [];
      nodes.push(crumbs([{ title: '书库', hash: '#/' }, ...data.breadcrumb.map((b) => ({ title: b.title, hash: '#/n/' + b.id })), { title: node.title }]));
      nodes.push(el('div', { class: 'title-row' }, el('h1', { text: node.title }),
        el('div', { class: 'meta' },
          el('span', { text: node.seriesCount + ' 部系列' }),
          el('span', { text: node.unitCount + ' 卷' }),
          node.size ? el('span', { text: fmtSize(node.size) }) : null)));
      nodes.push(toolbar());
      const sorted = sortItems(filterItems(children), state.sort);
      const groups = sorted.filter((c) => c.type === 'group');
      const rest = sorted.filter((c) => c.type !== 'group');
      if (groups.length) {
        nodes.push(el('div', { class: 'section-title' }, '分组', el('span', { class: 'sub', text: groups.length + ' 个' })));
        nodes.push(el('div', { class: 'grid' }, groups.map((c) => cardFor(c))));
      }
      if (rest.length) {
        nodes.push(el('div', { class: 'section-title' }, '作品', el('span', { class: 'sub', text: rest.length + ' 项' })));
        nodes.push(el('div', { class: 'grid' }, rest.map((c) => cardFor(c))));
      }
      if (!sorted.length) nodes.push(el('div', { class: 'empty', text: '这个分组下没有匹配的内容' }));
      $('#content').replaceChildren(...nodes);
    },
  };
  // Expand the tree branch of the current node.
  const root = state.lib && state.lib.roots.find((r) => r.id === (data.breadcrumb[0] ? data.breadcrumb[0].id : id));
  if (root) state.expanded.add(root.id);
  if (node.parentId) state.expanded.add(node.parentId);
  state.view.render();
  renderSidebar();
}

async function viewSeries(id) {
  const data = await api('/api/node/' + encodeURIComponent(id));
  const series = data.node;
  const units = data.units || [];
  let layout = localStorage.getItem('manga-layout') || 'grid';
  state.view = {
    id,
    name: 'series',
    render: () => {
      const nodes = [];
      nodes.push(crumbs([{ title: '书库', hash: '#/' }, ...data.breadcrumb.map((b) => ({ title: b.title, hash: '#/n/' + b.id })), { title: series.title }]));
      const coverImg = el('img', { alt: '' });
      const box = el('div', { class: 'big-cover' }, coverImg);
      const bigCoverId = series.coverId || series.coverUnitId || series.id;
      // The detail page can afford to wait for the cover to be generated.
      covers.attach(bigCoverId, coverImg, box, { eager: true, wait: true });

      const read = units.filter((u) => u.progress && u.progress.finished).length;
      const reading = units.filter((u) => u.progress && !u.progress.finished).length;
      const totalPages = units.reduce((n, u) => n + (u.pageCount || 0), 0);
      const nextUnit = units.find((u) => u.progress && !u.progress.finished) || units.find((u) => !u.progress) || units[0];

      const info = el('div', { class: 'info' },
        el('h1', { text: series.title }),
        el('div', { class: 'meta' },
          series.note ? el('span', { class: 'badge', text: series.note }) : null,
          el('span', { text: units.length + ' 卷' }),
          series.size ? el('span', { text: fmtSize(series.size) }) : null,
          totalPages ? el('span', { text: totalPages + ' 页' }) : null,
          read ? el('span', { class: 'badge ok', text: '已读 ' + read + ' 卷' }) : null,
          reading ? el('span', { class: 'badge accent', text: '在读 ' + reading + ' 卷' }) : null
        ),
        el('div', { class: 'meta mono', style: { marginTop: '8px' }, text: series.rel || series.path }),
        el('div', { class: 'actions' },
          el('button', {
            class: 'btn primary',
            text: nextUnit ? (nextUnit.progress ? '继续阅读 · ' + (nextUnit.title || '') : '开始阅读 · ' + (nextUnit.title || '')) : '没有可读卷',
            onclick: () => nextUnit && (location.hash = '#/r/' + nextUnit.id),
          }),
          el('button', {
            class: 'btn',
            text: '切换列表',
            onclick: () => {
              layout = layout === 'grid' ? 'list' : 'grid';
              localStorage.setItem('manga-layout', layout);
              state.view.render();
            },
          }),
          el('button', {
            class: 'btn',
            text: state.favorites && state.favorites.has(series.id) ? '★ 已收藏' : '☆ 收藏',
            onclick: async (e) => {
              const on = state.favorites && state.favorites.has(series.id);
              await api('/api/favorite', { method: 'POST', body: { id: series.id, favorite: !on } });
              if (!state.favorites) state.favorites = new Set();
              if (on) state.favorites.delete(series.id);
              else state.favorites.add(series.id);
              toast(on ? '已取消收藏' : '已收藏', 'ok');
              state.view.render();
            },
          })
        )
      );
      nodes.push(el('div', { class: 'series-head' }, box, info));
      nodes.push(toolbar());
      if (units.length > 60) nodes.push(el('div', { class: 'meta', text: '共 ' + units.length + ' 卷，可滚动查看' }));

      if (layout === 'list') {
        const list = el('div', { class: 'vol-list' });
        for (const u of units) list.append(volRow(u));
        nodes.push(list);
      } else {
        const grid = el('div', { class: 'vol-grid' });
        for (const u of units) grid.append(volCard(u));
        nodes.push(grid);
      }
      $('#content').replaceChildren(...nodes);
    },
  };
  api('/api/progress').then((p) => {
    state.favorites = new Set(p.favorites.map((f) => f.id));
    units.forEach((u) => { u.progress = p.items[u.id] || u.progress; });
    if (state.view.name === 'series') state.view.render();
  }).catch(() => {});
  state.view.render();
  renderSidebar();
}

function volCard(u) {
  const card = el('div', { class: 'vol' + (u.progress && u.progress.finished ? ' finished' : ''), onclick: () => (location.hash = '#/r/' + u.id) });
  card.append(el('div', { class: 'no', text: u.ordinal ? '第 ' + u.ordinal + ' 卷' : '' }));
  card.append(el('div', { class: 'vt', text: u.title }));
  card.append(el('div', { class: 'fmt' },
    el('span', { class: 'badge', text: FORMAT_LABEL[u.format] || u.format }),
    u.pageCount ? el('span', { class: 'badge', text: u.pageCount + '页' }) : null,
    u.size ? el('span', { class: 'badge', text: fmtSize(u.size) }) : null
  ));
  if (u.progress && u.progress.total) {
    const pct = Math.min(100, Math.round(((u.progress.page + 1) / u.progress.total) * 100));
    card.append(el('div', { class: 'bar' }, el('i', { style: { width: pct + '%' } })));
  }
  return card;
}

function volRow(u) {
  const row = el('div', { class: 'vol-row', onclick: () => (location.hash = '#/r/' + u.id) });
  row.append(el('div', { class: 'no', text: u.ordinal ? '#' + u.ordinal : '' }));
  row.append(el('div', { class: 'vt', text: u.title }));
  row.append(el('div', { class: 'meta', text: FORMAT_LABEL[u.format] || '' }));
  row.append(el('div', { class: 'meta', text: u.size ? fmtSize(u.size) : '' }));
  row.append(el('div', { class: 'meta', text: u.progress && u.progress.total ? u.progress.page + 1 + '/' + u.progress.total : '' }));
  return row;
}

async function viewSearch(q) {
  const data = await api('/api/search?q=' + encodeURIComponent(q));
  state.view = {
    name: 'search',
    render: () => {
      const nodes = [];
      nodes.push(crumbs([{ title: '书库', hash: '#/' }, { title: '搜索: ' + q }]));
      nodes.push(el('div', { class: 'title-row' }, el('h1', { text: '搜索 “' + q + '”' }), el('div', { class: 'meta' }, el('span', { text: data.results.length + ' 个结果' }))));
      nodes.push(toolbar());
      const grid = el('div', { class: 'grid' });
      for (const item of sortItems(filterItems(data.results), state.sort)) grid.append(cardFor(item));
      nodes.push(grid);
      if (!data.results.length) nodes.push(el('div', { class: 'empty', text: '没有找到匹配的作品' }));
      $('#content').replaceChildren(...nodes);
    },
  };
  state.view.render();
}

async function viewContinue() {
  const data = await api('/api/continue');
  state.view = {
    name: 'continue',
    render: () => {
      const nodes = [crumbs([{ title: '书库', hash: '#/' }, { title: '继续阅读' }])];
      nodes.push(el('div', { class: 'title-row' }, el('h1', { text: '继续阅读' })));
      const grid = el('div', { class: 'grid' });
      for (const it of data.items) {
        const card = cardFor(Object.assign({}, it.unit, { progress: it.progress }));
        grid.append(card);
      }
      nodes.push(grid);
      if (!data.items.length) nodes.push(el('div', { class: 'empty', text: '还没有阅读记录' }));
      $('#content').replaceChildren(...nodes);
    },
  };
  state.view.render();
}

async function viewFavorites() {
  const [data, prog] = await Promise.all([api('/api/all'), api('/api/progress')]);
  const favIds = new Set(prog.favorites.map((f) => f.id));
  state.favorites = favIds;
  const all = [...data.series, ...data.volumes];
  const items = all.filter((i) => favIds.has(i.id));
  state.view = {
    name: 'fav',
    render: () => {
      const nodes = [crumbs([{ title: '书库', hash: '#/' }, { title: '收藏' }])];
      nodes.push(el('div', { class: 'title-row' }, el('h1', { text: '收藏' }), el('div', { class: 'meta' }, el('span', { text: items.length + ' 项' }))));
      nodes.push(el('div', { class: 'grid' }, items.map((i) => cardFor(i))));
      if (!items.length) nodes.push(el('div', { class: 'empty', text: '还没有收藏任何作品' }));
      $('#content').replaceChildren(...nodes);
    },
  };
  state.view.render();
}

/* -------------------------------------------------------------------- reader */

const reader = {
  unitId: null,
  unit: null,
  siblings: [],
  kind: null,
  pages: [],
  total: 0,
  index: 0,
  mode: localStorage.getItem('manga-reader-mode') || 'scroll',
  fit: localStorage.getItem('manga-reader-fit') || 'width',
  rtl: localStorage.getItem('manga-reader-rtl') !== '0',
  zoom: 1,
  pdf: null,
  rendered: new Map(),
  saveTimer: null,
  idleTimer: null,
  stage: null,
  pollTimer: null,

  async open(unitId) {
    this.unitId = unitId;
    this.cleanup();
    readerEl.classList.remove('hidden');
    readerEl.classList.add('mode-' + this.mode);
    document.body.style.overflow = 'hidden';
    this.buildShell();
    this.status('正在读取卷信息…');
    try {
      const [info, desc] = await Promise.all([
        api('/api/unit/' + unitId),
        api('/api/pages/' + unitId + '?start=1'),
      ]);
      this.unit = info.unit;
      this.siblings = info.siblings || [];
      this.prevUnit = info.prev;
      this.nextUnit = info.next;
      this.renderHeader(info);
      await this.applyDescriptor(desc, info.unit.progress);
    } catch (err) {
      this.status('打开失败: ' + err.message);
    }
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('mousemove', this.onMove);
  },

  cleanup() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.scrollHandler && this.scrollTarget) {
      this.scrollTarget.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
      this.scrollTarget = null;
    }
    if (this.pdf) {
      try { this.pdf.destroy(); } catch { /* ignore */ }
    }
    this.pdf = null;
    this.pages = [];
    this.rendered = new Map();
    this.stage = null;
    readerEl.replaceChildren();
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('mousemove', this.onMove);
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
  },

  close() {
    this.flushProgress();
    this.cleanup();
    readerEl.classList.add('hidden');
    readerEl.classList.remove('mode-scroll', 'mode-single', 'mode-double');
    document.body.style.overflow = '';
    if (location.hash.startsWith('#/r/')) location.hash = this.lastHash || '#/';
    else route();
  },

  buildShell() {
    this.titleEl = el('span', { class: 'r-title' });
    const bar = el('div', { class: 'r-bar top' },
      el('button', { class: 'btn', text: '← 返回', onclick: () => this.close() }),
      this.titleEl,
      el('span', { class: 'spacer' }),
      this.modeSelect(),
      this.fitSelect(),
      el('button', { class: 'btn icon', text: 'A-', title: '缩小', onclick: () => this.setZoom(this.zoom - 0.15) }),
      el('button', { class: 'btn icon', text: 'A+', title: '放大', onclick: () => this.setZoom(this.zoom + 0.15) }),
      el('button', { class: 'btn icon', text: this.rtl ? '右→左' : '左→右', title: '阅读方向', onclick: (e) => { this.rtl = !this.rtl; localStorage.setItem('manga-reader-rtl', this.rtl ? '1' : '0'); e.target.textContent = this.rtl ? '右→左' : '左→右'; this.renderPages(); } }),
      el('button', { class: 'btn icon', text: '⛶', title: '全屏', onclick: () => this.toggleFullscreen() })
    );
    this.countEl = el('span', { class: 'r-count', text: '0 / 0' });
    this.trackEl = el('div', { class: 'bar-track' });
    this.trackFill = el('i');
    this.trackKnob = el('b');
    this.trackEl.append(this.trackFill, this.trackKnob);
    this.trackEl.addEventListener('click', (e) => {
      const rect = this.trackEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.goTo(Math.round(ratio * (this.total - 1)));
    });
    const bottom = el('div', { class: 'r-bar bottom' },
      el('button', { class: 'btn', text: '上一卷', onclick: () => this.gotoSibling(-1) }),
      this.trackEl,
      this.countEl,
      el('button', { class: 'btn', text: '下一卷', onclick: () => this.gotoSibling(1) })
    );
    this.stage = el('div', { class: 'r-stage' });
    readerEl.append(bar, this.stage, bottom);
    this.setImmersiveIdle();
  },

  modeSelect() {
    const sel = el('select', { class: 'r-select', onchange: (e) => { this.mode = e.target.value; localStorage.setItem('manga-reader-mode', this.mode); readerEl.classList.remove('mode-scroll', 'mode-single', 'mode-double'); readerEl.classList.add('mode-' + this.mode); this.renderPages(); } },
      ...[['scroll', '滚动'], ['single', '单页'], ['double', '双页']].map(([v, t]) => el('option', { value: v, selected: this.mode === v, text: t })));
    return sel;
  },

  fitSelect() {
    return el('select', { class: 'r-select', onchange: (e) => { this.fit = e.target.value; localStorage.setItem('manga-reader-fit', this.fit); this.renderPages(); } },
      ...[['width', '适应宽度'], ['height', '适应高度'], ['page', '适应页面']].map(([v, t]) => el('option', { value: v, selected: this.fit === v, text: t })));
  },

  setZoom(z) {
    this.zoom = Math.max(0.4, Math.min(3, z));
    if (this.pagesWrap) this.pagesWrap.style.setProperty('--zoom', String(this.zoom));
    if (this.kind === 'pdf') this.renderNearby(true);
  },

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else readerEl.requestFullscreen && readerEl.requestFullscreen();
  },

  setImmersiveIdle() {
    const reset = () => {
      readerEl.classList.remove('immersive');
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => readerEl.classList.add('immersive'), 3000);
    };
    this.onMove = reset;
    reset();
  },

  renderHeader(info) {
    const u = info.unit;
    this.titleEl.replaceChildren(
      document.createTextNode(u.title || ''),
      el('small', { text: [info.series ? info.series.title : '', u.ordinal ? '第 ' + u.ordinal + ' 卷' : '', u.pageCount ? u.pageCount + ' 页' : ''].filter(Boolean).join(' · ') })
    );
  },

  status(text, extra) {
    this.stage.replaceChildren(el('div', { class: 'r-hint' }, el('div', { text }), extra || null));
  },

  async applyDescriptor(desc, savedProgress) {
    if (desc.status === 'error') {
      this.status('无法打开这一卷: ' + (desc.error || '未知错误'),
        el('button', { class: 'btn', text: '下载原文件', onclick: () => window.open('/api/download/' + this.unitId, '_blank') }));
      return;
    }
    if (desc.status === 'running') {
      this.pollTimer = setTimeout(async () => {
        try {
          const next = await api('/api/pages/' + this.unitId + '?start=1');
          await this.applyDescriptor(next, savedProgress);
        } catch (err) {
          this.status('读取失败: ' + err.message);
        }
      }, 800);
      const p = desc.progress || { done: 0, total: 0 };
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      this.status('正在解压到本地缓存… ' + (p.total ? p.done + ' / ' + p.total + ' 页 (' + pct + '%)' : '准备中'),
        p.total ? el('div', { class: 'bar-track', style: { width: '260px' } }, el('i', { style: { width: pct + '%' } })) : null,
        el('div', { class: 'meta', text: '首次打开会解压整卷，之后翻页瞬间完成。' }));
      return;
    }
    if (desc.status !== 'ready') {
      this.status('这一卷暂时无法读取 (' + desc.status + ')');
      return;
    }

    this.kind = desc.kind;
    this.total = desc.pageCount || 0;
    const startPage = savedProgress && savedProgress.page > 0 ? savedProgress.page : 0;
    if (this.kind === 'pdf') {
      await this.initPdf(desc, startPage);
    } else {
      this.pages = desc.pages || [];
      this.total = this.pages.length;
      this.renderPages(startPage);
    }
    this.updateBar();
  },

  async initPdf(desc, startPage) {
    let pdfjs;
    try {
      pdfjs = await import('/vendor/pdfjs/pdf.mjs');
    } catch (err) {
      this.status('PDF 引擎加载失败: ' + err.message);
      return;
    }
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
    const task = pdfjs.getDocument({ url: desc.fileUrl, disableAutoFetch: false, rangeChunkSize: 65536 * 4 });
    this.pdf = await task.promise;
    this.total = this.pdf.numPages;
    api('/api/pages/' + this.unitId + '/count', { method: 'POST', body: { pageCount: this.total } }).catch(() => {});
    this.renderPages(startPage);
  },

  renderPages(startPage) {
    if (!this.stage) return;
    const start = Number.isFinite(startPage) ? startPage : (Number.isFinite(this.index) ? this.index : 0);
    if (this.pdf) return this.renderPdfPages(start);
    return this.renderImagePages(start);
  },

  pageUrl(i) {
    const p = this.pages[i];
    return p ? p.url : null;
  },

  renderImagePages(startPage) {
    const wrap = el('div', { class: 'pages mode-' + this.mode + ' fit-' + this.fit + (this.rtl ? ' rtl' : '') });
    wrap.style.setProperty('--zoom', String(this.zoom));
    this.pagesWrap = wrap;
    if (this.mode === 'scroll') {
      for (let i = 0; i < this.total; i++) {
        const img = el('img', { src: this.pageUrl(i), loading: i < 3 ? 'eager' : 'lazy', decoding: 'async', alt: '' });
        wrap.append(el('div', { class: 'page', dataset: { i: String(i) } }, img));
      }
      this.stage.replaceChildren(wrap);
      this.index = Math.max(0, Math.min(this.total - 1, startPage));
      requestAnimationFrame(() => this.scrollToPage(this.index, 'auto'));
      this.attachScrollSpy();
    } else {
      this.stage.replaceChildren(wrap);
      this.renderSpread();
    }
    this.updateBar();
  },

  spreadIndexes() {
    if (this.mode !== 'double') return [this.index];
    const first = this.rtl ? this.index : this.index;
    const a = first;
    const b = first + 1 < this.total ? first + 1 : null;
    return b == null ? [a] : [a, b];
  },

  renderSpread() {
    const wrap = this.pagesWrap;
    if (!wrap) return;
    wrap.replaceChildren();
    const idxs = this.spreadIndexes();
    const ordered = this.rtl ? idxs.slice().reverse() : idxs;
    for (const i of ordered) {
      wrap.append(el('div', { class: 'page', dataset: { i: String(i) } },
        el('img', { src: this.pageUrl(i), decoding: 'async', alt: '' })));
    }
    this.updateBar();
    this.saveProgress();
  },

  async renderPdfPages(startPage) {
    const wrap = el('div', { class: 'pdf-stage mode-' + this.mode + (this.rtl ? ' rtl' : '') });
    wrap.style.setProperty('--zoom', String(this.zoom));
    this.pagesWrap = wrap;
    this.stage.replaceChildren(wrap);
    this.index = Math.max(0, Math.min(this.total - 1, startPage));
    if (this.mode === 'scroll') {
      for (let i = 0; i < this.total; i++) {
        wrap.append(el('div', { class: 'pdf-page', dataset: { i: String(i) } }, el('canvas')));
      }
      this.attachScrollSpy();
      this.renderNearby(true);
      requestAnimationFrame(() => this.scrollToPage(this.index, 'auto'));
    } else {
      this.renderPdfSpread();
    }
  },

  renderPdfSpread() {
    const wrap = this.pagesWrap;
    if (!wrap || !this.pdf) return;
    wrap.replaceChildren();
    const idxs = this.spreadIndexes();
    const ordered = this.rtl ? idxs.slice().reverse() : idxs;
    for (const i of ordered) {
      wrap.append(el('div', { class: 'pdf-page', dataset: { i: String(i) } }, el('canvas')));
    }
    this.rendered = new Map();
    this.renderNearby(true);
    this.updateBar();
    this.saveProgress();
  },

  /** Always a [first, last] pair, even when a spread holds one page. */
  pdfVisibleRange() {
    if (this.mode === 'scroll') return [Math.max(0, this.index - 2), Math.min(this.total - 1, this.index + 2)];
    const idxs = this.spreadIndexes();
    return [Math.min(...idxs), Math.max(...idxs)];
  },

  renderNearby(force) {
    if (!this.pdf) return;
    const [from, to] = this.pdfVisibleRange();
    const stage = this.stage;
    for (let i = from; i <= to; i++) {
      if (!force && this.rendered.get(i)) continue;
      this.rendered.set(i, true);
      this.renderPdfPage(i).catch((err) => {
        console.warn('pdf page render failed', i, err);
        this.rendered.delete(i);
      });
    }
    // Free canvases far from the viewport to bound memory.
    if (this.mode === 'scroll') {
      for (const key of [...this.rendered.keys()]) {
        if (key < from - 6 || key > to + 6) {
          const holder = stage.querySelector('.pdf-page[data-i="' + key + '"]');
          if (holder) {
            const canvas = holder.querySelector('canvas');
            if (canvas) { canvas.width = 0; canvas.height = 0; }
          }
          this.rendered.delete(key);
        }
      }
    }
  },

  async renderPdfPage(i) {
    const page = await this.pdf.getPage(i + 1);
    const holder = this.stage.querySelector('.pdf-page[data-i="' + i + '"]');
    if (!holder) return;
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const stageW = this.stage.clientWidth || window.innerWidth;
    const stageH = this.stage.clientHeight || window.innerHeight;
    let fit = 1;
    if (this.fit === 'width') fit = stageW / base.width;
    else if (this.fit === 'height') fit = stageH / base.height;
    else fit = Math.min(stageW / base.width, stageH / base.height);
    const scale = Math.max(0.1, fit * this.zoom) * dpr;
    const viewport = page.getViewport({ scale });
    const canvas = holder.querySelector('canvas') || holder.append(el('canvas')) || holder.querySelector('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
    canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
    holder.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  },

  attachScrollSpy() {
    if (this.scrollHandler && this.scrollTarget) this.scrollTarget.removeEventListener('scroll', this.scrollHandler);
    const handler = () => {
      const stage = this.stage;
      if (!stage) return;
      const children = this.pagesWrap ? this.pagesWrap.children : null;
      if (!children || !children.length) return;
      const mid = stage.scrollTop + stage.clientHeight * 0.35;
      let lo = 0;
      let hi = children.length - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        const offset = children[m].offsetTop;
        if (offset < mid) lo = m + 1;
        else hi = m;
      }
      const found = Math.max(0, Math.min(children.length - 1, children[lo].offsetTop > mid ? lo - 1 : lo));
      if (found !== this.index) {
        this.index = found;
        this.updateBar();
        this.saveProgress();
        if (this.pdf) this.renderNearby(false);
      }
    };
    this.scrollHandler = handler;
    this.scrollTarget = this.stage;
    this.stage.addEventListener('scroll', handler, { passive: true });
  },

  scrollToPage(i) {
    const stage = this.stage;
    const children = this.pagesWrap ? this.pagesWrap.children : null;
    if (!stage || !children || !children[i]) return;
    const target = children[i];
    // Images get their height a moment after they load, so re-aim a few times
    // — but never touch a reader that was closed in the meantime.
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    const attempt = (tries) => {
      this.scrollTimer = null;
      if (this.stage !== stage) return;
      stage.scrollTop = Math.max(0, target.offsetTop - 4);
      if (tries > 0) this.scrollTimer = setTimeout(() => attempt(tries - 1), 220);
    };
    attempt(3);
  },

  goTo(i) {
    if (this.total <= 0) return;
    this.index = Math.max(0, Math.min(this.total - 1, i));
    if (this.mode === 'scroll') {
      this.scrollToPage(this.index, 'smooth');
    } else if (this.pdf) {
      this.renderPdfSpread();
    } else {
      this.renderSpread();
    }
  },

  next() {
    const step = this.mode === 'double' ? 2 : 1;
    if (this.mode === 'scroll') this.goTo(this.index + step);
    else if (this.index + step < this.total) this.goTo(this.index + step);
    else this.gotoSibling(1);
  },

  prev() {
    const step = this.mode === 'double' ? 2 : 1;
    if (this.index - step >= 0) this.goTo(this.index - step);
    else this.gotoSibling(-1);
  },

  gotoSibling(dir) {
    const target = dir > 0 ? this.nextUnit : this.prevUnit;
    if (!target) {
      toast(dir > 0 ? '已经是最后一卷' : '已经是第一卷');
      return;
    }
    this.flushProgress();
    this.lastHash = '#/s/' + (target.seriesId || '');
    location.hash = '#/r/' + target.id;
  },

  updateBar() {
    if (!this.countEl) return;
    const pct = this.total > 1 ? (this.index / (this.total - 1)) * 100 : 0;
    this.countEl.textContent = this.total ? this.index + 1 + ' / ' + this.total : '0 / 0';
    this.trackFill.style.width = pct + '%';
    this.trackKnob.style.left = pct + '%';
  },

  saveProgress() {
    if (!this.unitId || !this.total) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      api('/api/progress', { method: 'POST', body: { unitId: this.unitId, page: this.index, total: this.total } }).catch(() => {});
    }, 900);
  },

  flushProgress() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      if (this.unitId && this.total) {
        fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unitId: this.unitId, page: this.index, total: this.total }),
          keepalive: true,
        }).catch(() => {});
      }
    }
  },

  onKey(e) {
    const r = reader;
    if (!r.unitId) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case 'Escape':
        r.close();
        break;
      case 'f':
        r.toggleFullscreen();
        break;
      case '+':
      case '=':
        r.setZoom(r.zoom + 0.15);
        break;
      case '-':
        r.setZoom(r.zoom - 0.15);
        break;
      case '0':
        r.setZoom(1);
        break;
      case 'Home':
        r.goTo(0);
        e.preventDefault();
        break;
      case 'End':
        r.goTo(r.total - 1);
        e.preventDefault();
        break;
      default:
        if (r.mode === 'scroll') return;
        {
          const forwardKey = r.rtl ? ['ArrowLeft', 'ArrowUp'] : ['ArrowRight', 'ArrowDown'];
          const backKey = r.rtl ? ['ArrowRight', 'ArrowDown'] : ['ArrowLeft', 'ArrowUp'];
          if (forwardKey.includes(e.key) || e.key === ' ' || e.key === 'PageDown') {
            r.next();
            e.preventDefault();
          } else if (backKey.includes(e.key) || e.key === 'PageUp') {
            r.prev();
            e.preventDefault();
          }
        }
    }
  },
};

/* --------------------------------------------------------------------- events */

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'hello') {
      if (state.lib && data.scan) {
        state.lib.scan = data.scan;
        state.lib.stats = data.stats || state.lib.stats;
        renderStatus();
      }
      return;
    }
    if (data.type === 'scan') {
      if (data.phase === 'walk') {
        if (state.lib) { state.lib.scan = Object.assign({}, state.lib.scan, { running: true, visited: data.dirs, units: data.units }); renderStatus(); }
      } else if (data.phase === 'done') {
        if (state.lib) { state.lib.scan = Object.assign({}, state.lib.scan, { running: false }); }
        renderStatus();
        toast('扫描完成: ' + data.stats.series + ' 部系列 / ' + data.stats.units + ' 卷', 'ok');
        ensureLibrary(true).then(() => {
          renderSidebar();
          render();
          renderStatus();
        });
      } else if (data.phase === 'start') {
        toast('开始扫描…');
      } else if (data.phase === 'error') {
        toast('扫描失败: ' + data.error, 'err');
      }
    } else if (data.type === 'covers') {
      for (const id of data.ids) covers.ready(id, Date.now());
    } else if (data.type === 'cover') {
      if (data.ok) covers.ready(data.id, Date.now());
    } else if (data.type === 'pregen') {
      if (state.lib) {
        state.lib.pregen = data;
        renderStatus();
      }
      if (data.finished) toast('封面预生成完成 (' + data.done + '/' + data.total + ')', 'ok');
    }
  });
  es.addEventListener('error', () => { /* EventSource auto-reconnects */ });
}

/* ---------------------------------------------------------------------- boot */

async function boot() {
  // Handy for debugging from the browser console.
  window.manga = { state, reader, covers, api };
  buildShell();
  document.documentElement.style.setProperty('--card-w', state.cardW + 'px');
  try {
    state.cfg = await api('/api/config');
  } catch { /* ignore */ }
  window.addEventListener('hashchange', route);
  connectEvents();
  await route();
}

boot();
