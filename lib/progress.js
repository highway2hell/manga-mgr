'use strict';

/**
 * Reading progress + favourites, persisted as JSON so progress is shared
 * between browsers on the same machine (and survives a restart).
 */

const fs = require('fs');
const path = require('path');

class ProgressStore {
  constructor(config) {
    this.config = config;
    this.file = path.join(config.dataDir, 'progress.json');
    this.data = { items: {}, favorites: {} };
    this.load();
    this._timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = {
          items: raw.items && typeof raw.items === 'object' ? raw.items : {},
          favorites: raw.favorites && typeof raw.favorites === 'object' ? raw.favorites : {},
        };
      }
    } catch {
      /* first run */
    }
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
      } catch (err) {
        console.error('Could not save progress: ' + err.message);
      }
    }, 300);
    if (this._timer.unref) this._timer.unref();
  }

  /** Progress for one volume. */
  get(unitId) {
    return this.data.items[unitId] || null;
  }

  forUnits(ids) {
    const out = {};
    for (const id of ids) {
      const item = this.data.items[id];
      if (item) out[id] = item;
    }
    return out;
  }

  set(unitId, patch) {
    const prev = this.data.items[unitId] || {};
    const next = Object.assign({}, prev, patch, { updatedAt: Date.now() });
    if (next.page != null && next.total != null && next.total > 0 && next.page >= next.total - 1) {
      next.finished = true;
    }
    this.data.items[unitId] = next;
    this.prune();
    this.save();
    return next;
  }

  /** Keep the store from growing without bound on a large library. */
  prune(max = 4000) {
    const entries = Object.entries(this.data.items);
    if (entries.length <= max) return;
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    this.data.items = Object.fromEntries(entries.slice(0, max));
  }

  recent(limit = 24) {
    return Object.entries(this.data.items)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, limit)
      .map(([id, item]) => Object.assign({ unitId: id }, item));
  }

  favorite(id, meta) {
    if (meta === false) {
      delete this.data.favorites[id];
    } else {
      this.data.favorites[id] = Object.assign({ addedAt: Date.now() }, meta || {});
    }
    this.save();
    return this.data.favorites[id] || null;
  }

  isFavorite(id) {
    return !!this.data.favorites[id];
  }

  favorites() {
    return Object.entries(this.data.favorites)
      .sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0))
      .map(([id, meta]) => Object.assign({ id }, meta));
  }

  /** Aggregate progress per series (read volumes / total). */
  seriesSummary(unitIds) {
    let read = 0;
    let last = null;
    for (const id of unitIds || []) {
      const item = this.data.items[id];
      if (!item) continue;
      if (item.finished) read++;
      if (!last || (item.updatedAt || 0) > (last.updatedAt || 0)) last = item;
    }
    return { read, last };
  }
}

module.exports = { ProgressStore };
