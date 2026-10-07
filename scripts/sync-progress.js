'use strict';

/**
 * Sync reading progress + favourites between two manga-mgr instances.
 *
 * Ids are hashes of absolute paths, so the Mac `/Volumes/Public/Media/漫画/...`
 * and the server `/mnt/nas/Media/漫画/...` never share ids even though the files
 * are the same. This tool maps every record through its path relative to the
 * library root, then writes it to the target through the target's HTTP API
 * (which also validates that the volume still exists there).
 *
 *   node scripts/sync-progress.js                      # local -> remote
 *   node scripts/sync-progress.js --dry-run            # only report
 *   node scripts/sync-progress.js --from-remote        # remote -> local
 *   node scripts/sync-progress.js --host user@other    # another server
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const util = require('../lib/util');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { host: 'jacob@jacob-ubuntu-box', remoteDir: 'manga-mgr', direction: 'to-remote', dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') args.host = argv[++i];
    else if (a === '--remote-dir') args.remoteDir = argv[++i];
    else if (a === '--from-remote') args.direction = 'from-remote';
    else if (a === '--to-remote') args.direction = 'to-remote';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/sync-progress.js [--host user@host] [--remote-dir dir] [--from-remote|--to-remote] [--dry-run] [--force]');
      process.exit(0);
    } else {
      console.error('unknown option: ' + a);
      process.exit(2);
    }
  }
  return args;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Run a command on the remote host (stdin optional), return stdout. */
function ssh(host, command, input) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', host, command], {
    input,
    maxBuffer: 512 * 1024 * 1024,
  }).toString();
}

/**
 * Index a catalog tree: id -> path for volumes, and id -> {path, kind} for
 * series/groups/roots, which is what lets us translate ids across machines.
 */
function describeSide(label, index, port, progress) {
  const roots = (index.tree.roots || []).map((r) => ({ id: r.id, name: r.title || r.name, path: r.path }));
  const units = new Map();
  const nodes = new Map();

  const walk = (node) => {
    if (!node || !node.path) return;
    if (node.kind === 'series') {
      nodes.set(node.id, { path: node.path, kind: 'series' });
      for (const u of node.units || []) units.set(u.id, u.path);
      return;
    }
    if (node.kind === 'group' || node.kind === 'root') {
      nodes.set(node.id, { path: node.path, kind: node.kind });
      for (const child of node.children || []) walk(child);
      return;
    }
    units.set(node.id, node.path);
  };
  for (const root of index.tree.roots || []) walk(root);

  return { label, roots, units, nodes, port, progress, origin: index.__origin };
}

/** Map a path from one instance's library root layout onto the other's. */
function makePathMapper(from, to) {
  const pairs = new Map();
  for (const [i, fromRoot] of from.roots.entries()) {
    const byName = to.roots.find((r) => r.name === fromRoot.name);
    const target = byName || to.roots[i];
    if (target) pairs.set(fromRoot.path, target.path);
  }
  const rootFor = (p) =>
    from.roots
      .filter((r) => util.isInside(r.path, p))
      .sort((a, b) => b.path.length - a.path.length)[0];
  return (fromPath) => {
    const root = rootFor(fromPath);
    if (!root) return null;
    const targetRoot = pairs.get(root.path);
    if (!targetRoot) return null;
    return path.join(targetRoot, path.relative(root.path, fromPath));
  };
}

function buildTranslator(from, to) {
  const mapPath = makePathMapper(from, to);

  const translateVolume = (id) => {
    const p = from.units.get(id);
    if (!p) return null;
    const target = mapPath(p);
    if (!target) return null;
    const id2 = util.idFor(target);
    return to.units.has(id2) ? id2 : null;
  };

  const translateNode = (id) => {
    if (from.units.has(id)) return translateVolume(id);
    const node = from.nodes.get(id);
    if (!node) return null;
    const target = mapPath(node.path);
    if (!target) return null;
    const prefix = node.kind === 'series' ? 'series:' : node.kind === 'group' ? 'group:' : node.kind === 'root' ? 'root:' : '';
    if (!prefix) return null;
    const id2 = util.idFor(prefix + target);
    return to.nodes.has(id2) ? id2 : null;
  };

  return { translateVolume, translateNode };
}

/* ------------------------------------------------------------------- target */

function makeTarget(side, args) {
  const base = 'http://127.0.0.1:' + side.port;
  const isRemote = side.origin === 'remote';

  const post = async (endpoint, payload) => {
    const body = JSON.stringify(payload);
    if (isRemote) {
      const out = ssh(
        args.host,
        'curl -sS -X POST -H "Content-Type: application/json" --data-binary @- ' + base + endpoint,
        body
      );
      return JSON.parse(out);
    }
    const res = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(endpoint + ' -> ' + res.status);
    return res.json();
  };

  const get = async (endpoint) => {
    if (isRemote) return JSON.parse(ssh(args.host, 'curl -sS ' + base + endpoint));
    const res = await fetch(base + endpoint);
    if (!res.ok) throw new Error(endpoint + ' -> ' + res.status);
    return res.json();
  };

  return { post, get, isRemote };
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv);

  const localIndex = readJson(path.join(ROOT, 'data', 'index.json'));
  const localProgress = readJson(path.join(ROOT, 'data', 'progress.json'), { items: {}, favorites: {} });
  const localConfig = readJson(path.join(ROOT, 'config.json'), { port: 4311 });
  if (!localIndex) {
    console.error('No local index at data/index.json — start the app once so it scans the library.');
    process.exit(1);
  }

  process.stdout.write('Reading remote index from ' + args.host + ':~/' + args.remoteDir + ' ... ');
  const remoteIndex = JSON.parse(ssh(args.host, 'cat ~/' + args.remoteDir + '/data/index.json'));
  const remoteConfig = JSON.parse(ssh(args.host, 'cat ~/' + args.remoteDir + '/config.json'));
  const remoteProgress = JSON.parse(
    ssh(args.host, 'cat ~/' + args.remoteDir + '/data/progress.json 2>/dev/null || echo \'{"items":{},"favorites":{}}\'')
  );
  console.log('ok');

  const local = describeSide('local', localIndex, localConfig.port, localProgress);
  const remote = describeSide('remote', remoteIndex, remoteConfig.port, remoteProgress);
  local.origin = 'local';
  remote.origin = 'remote';

  const fromRemote = args.direction === 'from-remote';
  const source = fromRemote ? remote : local;
  const target = fromRemote ? local : remote;
  const { translateVolume, translateNode } = buildTranslator(source, target);
  const io = makeTarget(target, args);

  const srcItems = source.progress.items || {};
  const srcFavs = source.progress.favorites || {};
  const tgtItems = target.progress.items || {};
  const tgtFavs = target.progress.favorites || {};

  console.log(
    'direction: ' + (fromRemote ? 'remote -> local' : 'local -> remote') +
    ' | source: ' + Object.keys(srcItems).length + ' progress, ' + Object.keys(srcFavs).length + ' favourites' +
    ' | target already has: ' + Object.keys(tgtItems).length + ' progress, ' + Object.keys(tgtFavs).length + ' favourites'
  );

  // Volumes, newest last so the target ends up with the same "recent" order.
  const entries = Object.entries(srcItems).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
  let moved = 0;
  let skipped = 0;
  const unmatched = [];

  for (const [srcId, item] of entries) {
    const targetId = translateVolume(srcId);
    if (!targetId) {
      unmatched.push(item.title || srcId);
      continue;
    }
    const existing = tgtItems[targetId];
    if (existing && !args.force && (existing.updatedAt || 0) > (item.updatedAt || 0)) {
      skipped++;
      continue;
    }
    const label = (item.seriesTitle ? item.seriesTitle + ' · ' : '') + (item.title || '');
    if (args.dryRun) {
      console.log('  would sync  ' + label + '  -> page ' + (item.page + 1) + '/' + item.total);
      moved++;
      continue;
    }
    const res = await io.post('/api/progress', { unitId: targetId, page: item.page, total: item.total });
    if (res && res.ok) {
      moved++;
      console.log('  synced      ' + label + '  page ' + (item.page + 1) + '/' + item.total);
    } else {
      unmatched.push(label);
    }
  }

  let favsMoved = 0;
  for (const [srcId, meta] of Object.entries(srcFavs)) {
    const targetId = translateNode(srcId);
    if (!targetId) {
      unmatched.push('[收藏] ' + (meta.title || srcId));
      continue;
    }
    if (tgtFavs[targetId]) {
      skipped++;
      continue;
    }
    if (args.dryRun) {
      console.log('  would favourite ' + (meta.title || srcId));
      favsMoved++;
      continue;
    }
    await io.post('/api/favorite', { id: targetId, favorite: true });
    favsMoved++;
    console.log('  favourited  ' + (meta.title || srcId));
  }

  console.log(
    '\n' + (args.dryRun ? '[dry run] ' : '') + 'progress synced: ' + moved +
    ' | favourites synced: ' + favsMoved +
    ' | skipped (target newer): ' + skipped +
    ' | unmatched: ' + unmatched.length
  );
  if (unmatched.length) {
    console.log('unmatched entries (not present in the target library):');
    for (const u of unmatched.slice(0, 20)) console.log('  - ' + u);
  }

  if (!args.dryRun) {
    const after = await io.get('/api/continue');
    const progress = await io.get('/api/progress');
    console.log(
      '\ntarget now: ' + Object.keys(progress.items).length + ' progress records, ' +
      progress.favorites.length + ' favourites, ' +
      after.items.length + ' resolvable in 继续阅读'
    );
  }
}

main().catch((err) => {
  console.error('sync failed: ' + err.message);
  process.exit(1);
});
