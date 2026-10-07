'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Stable short id for a path (survives rescans, so reading progress sticks). */
function idFor(input, len = 14) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len);
}

const collator = new Intl.Collator(['zh-Hans-CN', 'ja-JP', 'en-US'], {
  numeric: true,
  sensitivity: 'base',
});

/** Locale-aware, number-aware string compare ("第9卷" < "第10卷"). */
function naturalCompare(a, b) {
  return collator.compare(String(a), String(b));
}

/** True when `child` is `parent` or lives below it (no path traversal). */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isHiddenName(name) {
  return name.startsWith('.') || name === 'Thumbs.db';
}

function extname(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * Launch at most `limit` async tasks at a time. Returns a promise for each
 * submitted task, so callers can await individual results.
 */
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const job = queue.shift();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  const run = createLimiter(limit);
  await Promise.all(
    items.map((item, i) => run(() => fn(item, i)).then((v) => { out[i] = v; }))
  );
  return out;
}

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

const BRACKET_TAG = /[\[【][^\]】]*[\]】]/g;

/**
 * Pretty title for a volume/chapter file name: drops release-group bracket
 * tags, site tags and underscores, collapses whitespace.
 * `[Vol.moe][大劍Claymore]第01卷` -> `第01卷`
 */
function cleanTitle(raw) {
  const original = stripExt(String(raw));
  const stripped = original.replace(BRACKET_TAG, ' ').replace(/\s+/g, ' ').trim();
  // Only use the stripped form when something meaningful is left.
  let s = stripped.length >= 2 ? stripped : original;
  s = s
    .replace(/[_]+/g, ' ')
    .replace(/^[\s._\-–—]+/, '')
    .replace(/[\s._\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || original;
}

// Publisher / edition / region tags that show up in release-style folder names.
const TAG_NOISE_RE = /^(?:mox\.?moe|vol\.?moe|comic|comics|kindle|download|scan|www\.[^\s]*|[a-z0-9.\-]*moe|tw|hk|cn|jp|kr|zh|c\.c|cc|东立|東立|尖端|青文|文传|文傳|天下|长鸿|長鴻|东贩|東販|苍出版|蒼出版|大然|时报|時報|玉皇朝|文化传信|角川|讲谈社|講談社|集英社|小学馆|小學館|白泉社|秋田书店|少年画报|正文社|东立电子版|東立電子版|简体版|繁體版|繁体版|电子版|高清|汉化|漢化|完结|已完结|完|全)$/i;

/** Tags that mean "how many volumes" rather than "what is this called". */
function isVolumeTag(text) {
  const t = String(text).trim();
  if (!t) return false;
  if (/^(?:全|共|至)?\s*\d+\s*(?:[-~+～]\s*\d+)?\s*[卷話话册冊集部篇回]?(?:\s*(?:未|完|完结))?$/.test(t)) return true;
  return /^(?:全|共|至)\s*\d+/.test(t) && /[卷話话册冊集部篇回]/.test(t);
}

/**
 * Readable title for a *folder* of a manga library, which is often a
 * release-style name: `[作者][作品][出版社]全10卷`.
 * Returns `{ title, note }` where note carries the volume count / status.
 */
function parseName(raw) {
  let name = String(raw).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  // Author folders in this library are prefixed with a sort letter: `A安达充`.
  const deLettered = name.replace(/^([A-Za-z])\s*(?=[\u3400-\u9fff])/, '');
  if (deLettered) name = deLettered;

  let note = '';

  if (/^[\[【]/.test(name)) {
    const tags = [];
    for (const m of name.matchAll(/[\[【]([^\]】]*)[\]】]/g)) {
      const t = m[1].trim();
      if (t) tags.push(t);
    }
    const plain = name.replace(BRACKET_TAG, ' ').replace(/\s+/g, ' ').trim();
    const cands = tags.filter((t) => !TAG_NOISE_RE.test(t) && !isVolumeTag(t));
    let title = cands.length >= 2 ? cands[1] : cands[0] || '';
    const vtag = tags.find(isVolumeTag);
    if (vtag) note = vtag;
    if (!title) title = plain || name;
    if (plain && isVolumeTag(plain)) note = note || plain;
    return { title: title.trim() || name, note };
  }

  // Plain name: peel trailing "(完)" / "(28)" / "(1-8未)" style markers.
  let t = name;
  const tailRe = /\s*(?:[\[【(（]([^\]】)）]{0,24})[\]】)）]|\s+\d+\s*[-~]\s*\d+)\s*$/;
  for (let i = 0; i < 4; i++) {
    const m = tailRe.exec(t);
    if (!m) break;
    const inner = (m[1] || '').trim();
    const droppable =
      !inner ||
      isVolumeTag(inner) ||
      TAG_NOISE_RE.test(inner) ||
      /^\d+$/.test(inner) ||
      inner.length > 10;
    if (!droppable) break;
    // Only volume/status markers are worth showing; a dropped long
    // parenthetical (a site slogan, a scanner credit) is noise.
    if (inner && isVolumeTag(inner)) note = note || inner;
    const cut = t.slice(0, m.index).trim();
    if (!cut) break;
    t = cut;
  }
  return { title: t || name, note };
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * Volume/chapter number of a name, for ordering. Understands
 * `第12卷`, `Vol_03`, `v10`, `ch.7`, `[12]` and a trailing number.
 * Returns null when the name carries no usable number.
 */
function volumeNumber(name) {
  const s = stripExt(String(name));
  let m = /第\s*(\d+)\s*[话話回卷册集部篇]/.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /第\s*([一二三四五六七八九十]+)\s*[话話回卷册集部篇]/.exec(s);
  if (m) return CN_NUM[m[1]] || null;
  m = /\b(?:vol|volume|v|ch|chapter|chap|话|話|回)\s*[._\-]?\s*(\d{1,4})\b/i.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /\[(\d{1,4})\]/.exec(s);
  if (m) return parseInt(m[1], 10);
  m = /(\d{1,4})(?!.*\d)/.exec(s);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** Sort key that keeps numbered volumes in order and unnumbered ones last. */
function volumeSortKey(name) {
  const n = volumeNumber(name);
  return n == null ? Number.MAX_SAFE_INTEGER : n;
}

/** Comparator for a list of volume/chapter names. */
function compareVolumes(a, b) {
  const na = volumeSortKey(a);
  const nb = volumeSortKey(b);
  if (na !== nb) return na - nb;
  if (na !== Number.MAX_SAFE_INTEGER && na === nb) {
    // Same number: keep release order stable, then fall back to the name.
    return naturalCompare(a, b);
  }
  return naturalCompare(a, b);
}


function statOrNull(p) {
  return fs.promises.stat(p).catch(() => null);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}


module.exports = {
  idFor,
  parseName,
  isVolumeTag,
  naturalCompare,
  compareVolumes,
  volumeNumber,
  volumeSortKey,
  isInside,
  isHiddenName,
  extname,
  createLimiter,
  mapLimit,
  cleanTitle,
  stripExt,
  statOrNull,
  sleep,
};
