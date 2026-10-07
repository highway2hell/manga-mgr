'use strict';

/**
 * Test suite for manga-mgr: unit tests for the parsing/scanning logic, plus a
 * live API test against a running server (skipped when nothing is listening).
 *
 *   node test/run.js            # unit + fixtures
 *   node test/run.js --api      # also exercise a running server on config port
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const util = require('../lib/util');
const zip = require('../lib/zip');
const { Library } = require('../lib/scanner');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => {
          passed++;
          console.log('  ✓ ' + name);
        },
        (err) => {
          failed++;
          failures.push(name + ': ' + err.message);
          console.log('  ✗ ' + name + '\n      ' + (err.message || err));
        }
      );
    }
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    failures.push(name + ': ' + err.message);
    console.log('  ✗ ' + name + '\n      ' + (err.message || err));
  }
  return Promise.resolve();
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ fixtures */

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeJpeg(seed, size = 400) {
  // A tiny but structurally valid JPEG (SOI + APP0 + EOI) padded with a comment.
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const body = Buffer.alloc(size, seed % 251);
  const tail = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, body, tail]);
}

/** Build a small ZIP archive with the given entries: [name, Buffer]. */
function makeZip(file, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(0, 42);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  writeFile(file, Buffer.concat([...local, centralBuf, eocd]));
}

function buildFixtureLibrary(root) {
  makeZip(path.join(root, '作者A', '作品1', '第01卷.zip'), [
    ['第01卷/0001.jpg', makeJpeg(1)], ['第01卷/0002.jpg', makeJpeg(2)], ['第01卷/readme.txt', Buffer.from('x')],
  ]);
  makeZip(path.join(root, '作者A', '作品1', '第02卷.zip'), [['0001.jpg', makeJpeg(3)]]);
  writeFile(path.join(root, '作者A', '作品2', '单行本.pdf'), '%PDF-1.4\n%%EOF\n');
  for (let i = 1; i <= 3; i++) writeFile(path.join(root, '作品3', '第1卷', String(i).padStart(4, '0') + '.jpg'), makeJpeg(i, 100));
  for (let i = 1; i <= 2; i++) writeFile(path.join(root, '作品3', '第2卷', '第2卷', String(i).padStart(4, '0') + '.jpg'), makeJpeg(i, 100));
  makeZip(path.join(root, '作品4', '子作品', 'a.zip'), [['1.jpg', makeJpeg(9)]]);
  makeZip(path.join(root, '作品4', '子作品', 'b.zip'), [['1.jpg', makeJpeg(10)]]);
  writeFile(path.join(root, '空目录', 'note.txt'), 'nothing readable here');
  writeFile(path.join(root, '作者A', '作品1', '第01卷.zip.baiduyun.p.downloading'), 'partial');
}

function fixtureConfig(dir, lib) {
  return {
    port: 0,
    host: '127.0.0.1',
    libraryDirs: [{ name: '测试库', path: lib }],
    bookExtensions: ['.pdf', '.mobi', '.epub'],
    archiveExtensions: ['.zip', '.rar', '.7z'],
    imageExtensions: ['.jpg', '.jpeg', '.png'],
    ignoreExtensions: ['.txt', '.downloading'],
    excludeNames: [],
    coverWidth: 200,
    cacheLimitGB: 1,
    scanOnStart: false,
    jobs: 2,
    cacheDir: path.join(dir, 'cache'),
    dataDir: path.join(dir, 'data'),
  };
}

async function runTests() {
  section('util');
  await test('cleanTitle strips release tags and separators', () => {
    assert.strictEqual(util.cleanTitle('[Vol.moe][大劍Claymore]第01卷.mobi'), '第01卷');
    assert.strictEqual(util.cleanTitle('[Mox.moe][尼祿]卷01.mobi'), '卷01');
    assert.strictEqual(util.cleanTitle('00.pdf'), '00');
    assert.strictEqual(util.cleanTitle('[Comic][次元艦隊][川口開治][Zipang][TW].Vol.35.7z'), 'Vol.35');
  });

  await test('parseName understands release-style folder names', () => {
    const cases = [
      ['[つくみず][少女终末旅行][青文]全6卷', '少女终末旅行', '全6卷'],
      ['[奥浩哉][杀戮都市][尖端]共37卷', '杀戮都市', '共37卷'],
      ['[麻生羽吕][僵尸百分百][简体版]至17卷', '僵尸百分百', '至17卷'],
      ['城市猎人(完)', '城市猎人', ''],
      ['妙手急先鋒1-2(完)', '妙手急先鋒1-2', ''],
      ['大剑Claymore(28)', '大剑Claymore', '28'],
      ['生存游戏BATTLE ROYALE（大逃杀）(完)', '生存游戏BATTLE ROYALE（大逃杀）', ''],
      ['孃王[娘王](1-8未)', '孃王[娘王]', '1-8未'],
      ['A安达充', '安达充', ''],
      ['CLAMP', 'CLAMP', ''],
      ['02_高清日漫合集(使用搜索寻找想看的漫画）', '02 高清日漫合集', ''],
      ['血十字', '血十字', ''],
    ];
    for (const [input, title, note] of cases) {
      const got = util.parseName(input);
      assert.strictEqual(got.title, title, input + ' -> ' + JSON.stringify(got));
      assert.strictEqual(got.note, note, input + ' note');
    }
  });

  await test('volume numbers sort naturally', () => {
    const names = ['卷10.rar', '卷1.rar', '第3卷', '卷2.rar', '外传'];
    assert.deepStrictEqual(names.slice().sort(util.compareVolumes), ['卷1.rar', '卷2.rar', '第3卷', '卷10.rar', '外传']);
    assert.strictEqual(util.volumeNumber('第11卷'), 11);
    assert.strictEqual(util.volumeNumber('Slds-TW_01.pdf'), 1);
    assert.strictEqual(util.volumeNumber('外传'), null);
  });

  await test('isInside blocks path traversal', () => {
    assert.ok(util.isInside('/a/b', '/a/b/c'));
    assert.ok(!util.isInside('/a/b', '/a/c'));
    assert.ok(!util.isInside('/a/b', '/a/b/../../etc/passwd'));
  });

  section('zip reader');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-test-'));
  await test('lists and extracts a zip without external tools', async () => {
    const file = path.join(tmp, 't.zip');
    makeZip(file, [['丁/一.jpg', makeJpeg(7)], ['丁/二.jpg', makeJpeg(8, 900)], ['丁/note.txt', Buffer.from('hi')]]);
    const entries = await zip.listEntries(file);
    assert.deepStrictEqual(entries, ['丁/一.jpg', '丁/二.jpg', '丁/note.txt']);
    const out = path.join(tmp, 'out.bin');
    await zip.extractEntryTo(file, '丁/二.jpg', out);
    const data = fs.readFileSync(out);
    assert.strictEqual(data[0], 0xff);
    assert.strictEqual(data[1], 0xd8);
    assert.strictEqual(data.length, makeJpeg(8, 900).length);
  });

  section('scanner (fixture library)');
  const libRoot = path.join(tmp, 'library');
  buildFixtureLibrary(libRoot);
  const cfg = fixtureConfig(tmp, libRoot);
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const lib = new Library(cfg);
  await test('builds series / group / single-volume tree', async () => {
    await lib.scan({ force: true });
    const root = lib.tree.roots[0];
    assert.ok(root, 'root exists');
    const byTitle = new Map(root.children.map((c) => [c.title, c]));
    assert.ok(byTitle.has('作者A'), 'author group present');
    assert.ok(byTitle.has('作品3'), 'image-folder series present');
    assert.ok(byTitle.has('子作品'), 'nested-folder series present');
    assert.ok(!byTitle.has('空目录'), 'unreadable folder dropped');

    const work1 = byTitle.get('作者A').children.find((c) => c.title === '作品1');
    assert.strictEqual(work1.kind, 'series');
    assert.strictEqual(work1.units.length, 2, 'two volumes, .downloading ignored');
    assert.ok(work1.units[0].title.startsWith('第01'), 'volumes sorted');

    const work3 = byTitle.get('作品3');
    assert.strictEqual(work3.kind, 'series');
    assert.strictEqual(work3.units.length, 2);
    assert.strictEqual(work3.units[0].kind, 'imageDir');
    assert.strictEqual(work3.units[0].title, '第1卷', 'collapsed nested image folder keeps outer name');
    assert.strictEqual(work3.units[0].pageCount, 3);

    // A folder whose only child is a series collapses onto that series.
    const work4 = byTitle.get('子作品');
    assert.strictEqual(work4.kind, 'series');
    assert.strictEqual(work4.units.length, 2, 'nested chapter folders fold into one series');
    const author = byTitle.get('作者A');
    assert.strictEqual(author.kind, 'group', 'author folder with a series and a lone volume is a group');
    assert.ok(
      author.children.some((c) => c.kind === 'series' && c.title === '作品1'),
      'series child kept'
    );
    assert.ok(
      author.children.some((c) => c.kind === 'pdf'),
      'standalone volume child kept (not swallowed by the sibling series)'
    );

  });

  await test('incremental scan reuses untouched folders', async () => {
    const before = lib.state.visited;
    await lib.scan({ force: false });
    assert.ok(lib.state.reused >= 1, 'reused at least the root (was ' + lib.state.reused + ')');
    assert.strictEqual(lib.state.visited, 0, 'nothing re-listed (before ' + before + ')');
  });

  await test('incremental scan notices new files', async () => {
    makeZip(path.join(libRoot, '作者A', '作品1', '第03卷.zip'), [['1.jpg', makeJpeg(11)]]);
    const t = Date.now() / 1000 + 2;
    fs.utimesSync(path.join(libRoot, '作者A', '作品1'), t, t);
    await lib.scan({ force: false });
    const work1 = lib.series.values();
    let found = null;
    for (const s of work1) if (s.title === '作品1') found = s;
    assert.ok(found, 'series still present');
    assert.strictEqual(found.units.length, 3, 'new volume picked up');
  });

  await test('progress is keyed by stable ids', async () => {
    const series = [...lib.series.values()].find((s) => s.title === '作品1');
    const idBefore = series.units[0].id;
    await lib.scan({ force: true });
    const series2 = [...lib.series.values()].find((s) => s.title === '作品1');
    assert.strictEqual(series2.units[0].id, idBefore, 'ids survive a rescan');
    assert.strictEqual(series2.id, series.id, 'series id survives a rescan');
  });

  section('pages');
  const { PageStore } = require('../lib/pages');
  global.__PageStore = PageStore;
  const { CoverStore } = require('../lib/covers');
  const store = new PageStore(cfg, lib, () => {});
  await test('extracts an archive into the local cache and serves pages', async () => {
    const series = [...lib.series.values()].find((s) => s.title === '作品1');
    const unit = series.units.find((u) => u.kind === 'archive');
    let desc = store.describe(unit, { start: true });
    for (let i = 0; i < 60 && desc.status !== 'ready'; i++) {
      await util.sleep(120);
      desc = store.describe(unit, { start: false });
    }
    assert.strictEqual(desc.status, 'ready', 'extraction finished');
    assert.strictEqual(desc.pageCount, 2, 'text entry filtered out');
    const file = store.pageFile(unit, 0);
    assert.ok(file && fs.existsSync(file), 'page file exists');
    assert.ok(fs.statSync(file).size > 100);
  });

  await test('image folders are read in place (no copying)', async () => {
    const series = [...lib.series.values()].find((s) => s.title === '作品3');
    const unit = series.units[0];
    let desc = store.describe(unit, { start: true });
    for (let i = 0; i < 40 && desc.status !== 'ready'; i++) {
      await util.sleep(100);
      desc = store.describe(unit, { start: false });
    }
    assert.strictEqual(desc.status, 'ready');
    const file = store.pageFile(unit, 0);
    assert.ok(file.startsWith(unit.path), 'served from the library folder');
  });

  await test('covers are generated and cached locally', async () => {
    const covers = new CoverStore(cfg, lib, store, () => {});
    const series = [...lib.series.values()].find((s) => s.title === '作品1');
    const file = await covers.get(series.id, { wait: true, timeout: 15000 });
    assert.ok(file && fs.existsSync(file), 'cover file written');
    assert.ok(fs.statSync(file).size > 100);
    assert.ok(covers.has(series.id), 'reported as ready');
  });

  section('robustness');
  await test('lazy size/mtime enrichment does not invalidate an extraction', async () => {
    const store = new global.__PageStore(cfg, lib, () => {});
    const series = [...lib.series.values()].find((s) => s.title === '作品1');
    const unit = series.units.find((u) => u.kind === 'archive');
    // Simulate the scanner learning the size after the extraction was cached.
    const before = { size: unit.size, mtimeMs: unit.mtimeMs };
    unit.size = null;
    unit.mtimeMs = null;
    let desc = store.describe(unit, { start: true });
    for (let i = 0; i < 80 && desc.status !== 'ready'; i++) {
      await util.sleep(120);
      desc = store.describe(unit, { start: false });
    }
    assert.strictEqual(desc.status, 'ready');
    unit.size = before.size;
    unit.mtimeMs = before.mtimeMs;
    const again = store.describe(unit, { start: false });
    assert.strictEqual(again.status, 'ready', 'still ready after the index learned the size');
    assert.ok(again.pages && again.pages.length > 0, 'pages are returned');
  });

  await test('a failed page write rejects instead of crashing the process', async () => {
    const { writeImage } = require('../lib/mobi');
    const source = path.join(tmp, 'source.bin');
    fs.writeFileSync(source, Buffer.alloc(4096, 3));
    const page = { chunks: [{ offset: 0, size: 64 }], type: 'jpg', size: 64 };
    // The target directory does not exist: the write stream errors asynchronously.
    await assert.rejects(
      () => writeImage(source, page, path.join(tmp, 'no-such-dir', 'page.jpg')),
      /ENOENT/
    );
  });

  await test('scratch directories are never treated as cache entries', async () => {
    const store = new global.__PageStore(cfg, lib, () => {});
    const scratch = path.join(cfg.cacheDir, 'extract', 'deadbeef.tmp-1-abc');
    fs.mkdirSync(scratch, { recursive: true });
    const removed = store.purgeStale();
    assert.ok(fs.existsSync(scratch), 'in-flight scratch dir kept');
    assert.strictEqual(removed, 0);
    assert.strictEqual(store.cleanScratch(), 1, 'orphan scratch dir cleaned on demand');
    assert.ok(!fs.existsSync(scratch));
  });

  section('server (live API)');
  const wantApi = process.argv.includes('--api') || process.env.MANGA_API === '1';
  if (!wantApi) {
    console.log('  (skipped — run with --api against a running server)');
  } else {
    const cfgFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const base = 'http://' + (cfgFile.host || '127.0.0.1') + ':' + cfgFile.port;
    const get = async (p) => {
      const res = await fetch(base + p);
      if (!res.ok) throw new Error(p + ' -> ' + res.status);
      return res.json();
    };
    await test('library tree is served', async () => {
      const data = await get('/api/library');
      assert.ok(data.roots.length >= 1, 'at least one root');
      assert.ok(data.stats.units > 0, 'units indexed');
    });
    await test('series detail carries cover + volumes', async () => {
      const all = await get('/api/all');
      assert.ok(all.series.length > 0);
      const detail = await get('/api/node/' + all.series[0].id);
      assert.ok(detail.units.length > 0);
      assert.ok(detail.node.coverId);
    });
    await test('every format yields readable pages', async () => {
      const all = await get('/api/all');
      const wanted = { pdf: null, archive: null, mobi: null, imageDir: null };
      for (const s of all.series) {
        if (Object.values(wanted).every(Boolean)) break;
        const detail = await get('/api/node/' + s.id);
        for (const u of detail.units) if (!wanted[u.format]) wanted[u.format] = u;
      }
      for (const [format, unit] of Object.entries(wanted)) {
        if (!unit) continue;
        if (format === 'pdf') {
          const desc = await get('/api/pages/' + unit.id + '?start=1');
          assert.strictEqual(desc.kind, 'pdf');
          const res = await fetch(base + desc.fileUrl, { headers: { Range: 'bytes=0-1023' } });
          assert.strictEqual(res.status, 206, 'pdf supports range requests');
          assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
          continue;
        }
        let desc = await get('/api/pages/' + unit.id + '?start=1');
        for (let i = 0; i < 200 && desc.status === 'running'; i++) {
          await util.sleep(500);
          desc = await get('/api/pages/' + unit.id);
        }
        assert.strictEqual(desc.status, 'ready', format + ' extractable');
        const res = await fetch(base + '/api/page/' + unit.id + '/0');
        assert.strictEqual(res.status, 200, format + ' page served');
        const buf = Buffer.from(await res.arrayBuffer());
        assert.ok(buf.length > 1000, format + ' page has content');
        const cover = await fetch(base + '/api/cover/' + unit.id + '?wait=1');
        assert.strictEqual(cover.status, 200, format + ' cover generated');
        assert.ok((await cover.arrayBuffer()).byteLength > 500);
      }
    });
    await test('scan endpoint responds', async () => {
      const res = await fetch(base + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":false}' });
      assert.ok(res.status === 202);
      const status = await get('/api/scan/status');
      assert.ok(status.stats.units > 0);
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

runTests().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(failed ? 1 : 0);
});
