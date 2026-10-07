'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  port: 4311,
  host: '127.0.0.1',
  libraryDirs: [{ name: '漫画库', path: '/path/to/your/manga' }],
  bookExtensions: ['.pdf', '.mobi', '.epub', '.azw3', '.fb2', '.djvu'],
  archiveExtensions: ['.zip', '.rar', '.cbz', '.cbr', '.7z'],
  imageExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif'],
  ignoreExtensions: ['.txt', '.db', '.downloading', '.part', '.tmp', '.apk', '.exe', '.nfo', '.url', '.opf', '.xml', '.json'],
  excludeNames: [],
  coverWidth: 400,
  cacheLimitGB: 30,
  scanOnStart: true,
  jobs: 2,
};

let config = null;
let configPath = null;

function normalizeDirEntry(entry) {
  if (typeof entry === 'string' && entry.trim()) {
    const p = entry.trim();
    return { name: path.basename(p) || p, path: p };
  }
  if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim()) {
    const p = entry.path.trim();
    return { name: (entry.name || '').trim() || path.basename(p) || p, path: p };
  }
  return null;
}

function normalize(raw) {
  const cfg = Object.assign({}, DEFAULTS, raw || {});
  cfg.libraryDirs = (cfg.libraryDirs || []).map(normalizeDirEntry).filter(Boolean);
  if (cfg.libraryDirs.length === 0) cfg.libraryDirs = DEFAULTS.libraryDirs.slice();
  for (const key of [
    'bookExtensions',
    'archiveExtensions',
    'imageExtensions',
    'ignoreExtensions',
    'excludeNames',
  ]) {
    const list = Array.isArray(cfg[key]) ? cfg[key] : DEFAULTS[key];
    cfg[key] = list
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => (key.endsWith('Extensions') ? v.trim().toLowerCase() : v.trim()));
  }
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.host = typeof cfg.host === 'string' && cfg.host ? cfg.host : DEFAULTS.host;
  cfg.coverWidth = Math.min(1200, Math.max(120, Number(cfg.coverWidth) || DEFAULTS.coverWidth));
  cfg.cacheLimitGB = Math.max(1, Number(cfg.cacheLimitGB) || DEFAULTS.cacheLimitGB);
  cfg.jobs = Math.min(8, Math.max(1, Number(cfg.jobs) || DEFAULTS.jobs));
  cfg.scanOnStart = cfg.scanOnStart !== false;
  cfg.cacheDir = path.resolve(ROOT, cfg.cacheDir || 'cache');
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir || 'data');
  return cfg;
}

function load() {
  configPath = path.join(ROOT, 'config.json');
  let raw = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error('config.json is not valid JSON: ' + err.message);
      console.error('Falling back to built-in defaults.');
      raw = {};
    }
  } else {
    raw = DEFAULTS;
    try {
      fs.writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
      console.log('Wrote a starter config.json (edit it to point at your libraries).');
    } catch (err) {
      console.error('Could not write config.json: ' + err.message);
    }
  }

  config = normalize(raw);

  // A library root that does not exist is a configuration mistake worth
  // shouting about, but it must not stop the server from starting.
  for (const dir of config.libraryDirs) {
    if (!fs.existsSync(dir.path)) {
      console.error('Warning: library path does not exist (will be skipped): ' + dir.path);
    }
  }

  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.cacheDir, 'covers'), { recursive: true });
  fs.mkdirSync(path.join(config.cacheDir, 'extract'), { recursive: true });

  return config;
}

function get() {
  return config || load();
}

module.exports = { load, get, DEFAULTS, configPath: () => configPath };
