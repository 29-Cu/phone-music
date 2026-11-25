'use strict';

// 网易云音源的离线测试:假的接口服务(fetch 是假的),不连外网、不连真的网易云。
// 跑:node --test test/netease.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createNetease, LOGIN_MSG, BLOCK_MSG } = require('../server/sources/netease.js');

const SONG = 64 * 1024;
const API = 'http://127.0.0.1:3999';

function audio(seed) {
  const b = Buffer.alloc(SONG);
  for (let i = 0; i < b.length; i++) b[i] = (i * 5 + Number(seed)) & 0xff;
  return b;
}

function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

const ROOTS = [];
test.after(() => { for (const d of ROOTS) fs.rmSync(d, { recursive: true, force: true }); });

function N(id, name, ar, dtSec) {
  return { id, name, ar: ar.map((n) => ({ id: 1, name: n })), dt: dtSec * 1000, al: { id: 1, name: 'al' } };
}

const LIB = {
  101: N(101, '晴天', ['周杰伦'], 269),
  102: N(102, '晴天', ['周杰伦'], 270),
  103: N(103, '晴天', ['别人'], 200),
  201: N(201, '稻香', ['周杰伦'], 223),
  301: N(301, '七里香', ['周杰伦'], 299),
};

// cfg.urls[id] = { exhigh: 'full'|'trial'|null, standard: ... }
function mockNe(cfg) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const body = new URLSearchParams(init && init.body ? String(init.body) : '');
    const call = { url: u, init, body, path: u.pathname, q: u.searchParams };
    calls.push(call);
    if (cfg.down) throw new TypeError('fetch failed');
    if (u.origin === API) {
      if (cfg.block && cfg.block.includes(u.pathname)) return json({ code: -460, message: '网络环境存在风险' }, 400);
      if (u.pathname === '/cloudsearch') {
        const ids = (cfg.search && cfg.search[u.searchParams.get('keywords')]) || [];
        return json({ code: 200, result: { songs: ids.map((i) => LIB[i]), songCount: ids.length } });
      }
      if (u.pathname === '/song/url/v1') {
        if (cfg.needLogin) return json({ code: 301, msg: '需要登录' }, 301);
        const id = u.searchParams.get('id');
        const level = u.searchParams.get('level');
        const st = ((cfg.urls || {})[id] || {})[level];
        const item = { id: Number(id), url: null, br: 0, code: 404, type: null, freeTrialInfo: null, level };
        if (st === 'full' || st === 'm4a') Object.assign(item, { url: 'http://m701.music.126.net/x/' + id + '-' + level + '.' + (st === 'm4a' ? 'm4a' : 'mp3'), br: level === 'exhigh' ? 320000 : 128000, code: 200, type: st === 'm4a' ? 'm4a' : 'mp3' });
        if (st === 'trial') Object.assign(item, { url: 'http://m701.music.126.net/x/' + id + '-trial.mp3', br: 128000, code: 200, type: 'mp3', freeTrialInfo: { start: 0, end: 30 } });
        if (st === 'evil') Object.assign(item, { url: 'http://cdn.example.org/' + id + '.mp3', code: 200, type: 'mp3' });
        return json({ code: 200, data: [item] });
      }
      if (u.pathname === '/song/detail') {
        const s = LIB[u.searchParams.get('ids')];
        return json({ code: 200, songs: s ? [s] : [] });
      }
      if (u.pathname === '/login/status') {
        return json({ data: { code: 200, account: { id: 555 }, profile: cfg.loggedOut ? null : { userId: 555, nickname: 'me' } } });
      }
      if (u.pathname === '/user/playlist') return json(cfg.userPlaylist || { code: 200, playlist: [] });
      if (u.pathname === '/playlist/track/all') {
        const all = (cfg.tracks || {})[u.searchParams.get('id')] || [];
        const off = Number(u.searchParams.get('offset'));
        const lim = Number(u.searchParams.get('limit'));
        return json({ code: 200, songs: all.slice(off, off + lim) });
      }
      return json({ code: 404 }, 404);
    }
    if (u.hostname.endsWith('.126.net') || u.hostname.endsWith('example.org')) {
      call.cdn = u.pathname;
      return new Response(audio(u.pathname.match(/(\d+)/)[1]));
    }
    return new Response('nope', { status: 404 });
  };
  fn.calls = calls;
  fn.api = (p) => calls.filter((c) => c.path === p);
  fn.cdn = () => calls.filter((c) => c.cdn).map((c) => c.cdn);
  fn.reset = () => { calls.length = 0; };
  return fn;
}

function setup(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netest-'));
  ROOTS.push(root);
  const cookieFile = path.join(root, 'cookie.txt');
  if (o.cookie !== null) fs.writeFileSync(cookieFile, o.cookie || 'MUSIC_U=TESTMUSICU; __csrf=c1');
  const net = mockNe(o.cfg || {});
  const ne = createNetease({
    apiBase: o.apiBase === undefined ? API + '/' : o.apiBase,
    cookieFile,
    cacheDir: path.join(root, 'cache'),
    playlistCacheDir: path.join(root, 'playlists'),
    fetch: net,
  });
  return { root, cookieFile, net, ne, cacheDir: path.join(root, 'cache') };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => handler(req, res, new URL(req.url, 'http://x').searchParams.get('n')));
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port + '/' }));
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('fetchSong:搜索 → 320k 链接 → 下进缓存;cookie 只在请求体里', async () => {
  const t = setup({ cfg: { search: { '晴天 周杰伦': [101, 102] }, urls: { 101: { exhigh: 'full' } } } });
  const r = await t.ne.fetchSong('晴天 周杰伦');
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(Object.assign({}, r.track, { file: '' }),
    { id: 'ne-101', title: '晴天 - 周杰伦', url: '/api/ne/101.mp3', file: '', duration: 269 });
  assert.ok(fs.existsSync(r.track.file));
  assert.deepStrictEqual([r.cached, r.alt], [false, false]);
  assert.deepStrictEqual(r.others, [{ name: '晴天', artist: '周杰伦', interval: 270 }]);
  const s = t.net.api('/cloudsearch')[0];
  assert.deepStrictEqual([s.q.get('keywords'), s.q.get('type'), s.q.get('limit')], ['晴天 周杰伦', '1', '10']);
  for (const c of t.net.calls.filter((x) => x.url.origin === API)) {
    assert.strictEqual(c.init.method, 'POST');
    assert.strictEqual(c.body.get('cookie'), 'MUSIC_U=TESTMUSICU; __csrf=c1');
    assert.ok(!c.url.href.includes('TESTMUSICU'));
    assert.ok(c.q.get('timestamp'));
  }
  assert.deepStrictEqual(t.net.api('/song/url/v1').map((c) => c.q.get('level')), ['exhigh']);
  t.net.reset();
  const again = await t.ne.fetchSong('周杰伦 晴天');
  assert.deepStrictEqual([again.ok, again.cached, t.net.calls.length], [true, true, 0]);
});

test('音质:exhigh 只给试听片段 → 退到 standard', async () => {
  const t = setup({ cfg: { search: { '稻香': [201] }, urls: { 201: { exhigh: 'trial', standard: 'full' } } } });
  const r = await t.ne.fetchSong('稻香');
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(t.net.api('/song/url/v1').map((c) => c.q.get('level')), ['exhigh', 'standard']);
  assert.deepStrictEqual(t.net.cdn(), ['/x/201-standard.mp3']);
});

test('resolve:第一条只有试听/没链接 → 试下一条', async () => {
  const t = setup({ cfg: { search: { '晴天': [101, 102, 103] }, urls: { 101: { exhigh: 'trial', standard: 'trial' }, 102: { standard: 'full' } } } });
  const r = await t.ne.fetchSong('晴天');
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.track.id, 'ne-102');
  assert.ok(!t.net.cdn().some((p) => p.includes('trial')));
});

test('全是试听 → 报拿不到完整链接(不是登录问题)', async () => {
  const t = setup({ cfg: { search: { '晴天': [101] }, urls: { 101: { exhigh: 'trial', standard: 'trial' } } } });
  const r = await t.ne.fetchSong('晴天');
  assert.strictEqual(r.ok, false);
  assert.ok(!r.login);
  assert.match(r.msg, /试听/);
});

test('换版:这一版只有试听,按歌单带的歌名歌手找同一首别的版本(<4 分的不要)', async () => {
  const t = setup({ cfg: { search: { '晴天 周杰伦': [101, 103, 102] },
    urls: { 101: { exhigh: 'trial', standard: null }, 103: { exhigh: 'full' }, 102: { exhigh: 'full' } } } });
  const r = await t.ne.fetchId('ne-101', { hint: { name: '晴天', artist: '周杰伦', interval: 269 } });
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.alt, true);
  assert.strictEqual(r.track.id, 'ne-101');
  assert.ok(r.track.file.endsWith(path.join('cache', '101.mp3')));
  assert.deepStrictEqual(t.net.cdn(), ['/x/102-exhigh.mp3']);
  assert.strictEqual(t.net.api('/song/detail').length, 0);
  assert.ok(!t.net.api('/song/url/v1').some((c) => c.q.get('id') === '103'));
});

test('换版:没 hint 时先查 /song/detail', async () => {
  const t = setup({ cfg: { search: { '晴天 周杰伦': [101, 102] }, urls: { 102: { exhigh: 'full' } } } });
  const r = await t.ne.fetchId('101');
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.alt, true);
  assert.strictEqual(t.net.api('/song/detail')[0].q.get('ids'), '101');
  assert.strictEqual(r.track.title, '晴天 - 周杰伦');
});

test('-460 → 说清楚是网络被拦,不是登录', async () => {
  let t = setup({ cfg: { block: ['/cloudsearch'] } });
  let r = await t.ne.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.login, r.msg], [false, undefined, BLOCK_MSG]);
  assert.match(BLOCK_MSG, /-460/);
  t = setup({ cfg: { search: { '晴天': [101] }, block: ['/song/url/v1'] } });
  r = await t.ne.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.msg], [false, BLOCK_MSG]);
  r = await t.ne.fetchId('101', { hint: { name: '晴天', artist: '周杰伦' } });
  assert.deepStrictEqual([r.ok, r.msg], [false, BLOCK_MSG]);
  t = setup({ cfg: { block: ['/login/status'] } });
  const st = await t.ne.status();
  assert.deepStrictEqual([st.logged_in, st.msg], [false, BLOCK_MSG]);
});

test('需要登录(301)→ login', async () => {
  const t = setup({ cfg: { search: { '晴天': [101] }, needLogin: true } });
  const r = await t.ne.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.login, r.msg], [false, true, LOGIN_MSG]);
  assert.match(LOGIN_MSG, /--site netease/);
});

test('接口服务连不上 / 没配置', async () => {
  let t = setup({ cfg: { down: true } });
  let r = await t.ne.fetchSong('晴天');
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /NETEASE_API/);
  t = setup({ apiBase: '', cfg: {} });
  assert.strictEqual(t.ne.enabled(), false);
  r = await t.ne.fetchSong('晴天');
  assert.match(r.msg, /NETEASE_API/);
  assert.strictEqual((await t.ne.status()).enabled, false);
  assert.strictEqual(t.net.calls.length, 0);
});

test('status:登录了 / 没登录 / cookie 文件只放了 MUSIC_U 的值', async () => {
  let t = setup({ cfg: {} });
  assert.strictEqual(t.ne.enabled(), true);
  let st = await t.ne.status();
  assert.deepStrictEqual([st.enabled, st.logged_in, st.expires_at], [true, true, 0]);
  t = setup({ cfg: { loggedOut: true } });
  st = await t.ne.status();
  assert.deepStrictEqual([st.logged_in, st.msg], [false, LOGIN_MSG]);
  t = setup({ cookie: 'RAWVALUE123', cfg: {} });
  await t.ne.status();
  assert.strictEqual(t.net.calls[0].body.get('cookie'), 'MUSIC_U=RAWVALUE123');
  t = setup({ cookie: null, cfg: {} });
  assert.strictEqual(t.ne.enabled(), false);
  t = setup({ cookie: 'NMTID=1; other=2', cfg: {} });
  st = await t.ne.status();
  assert.deepStrictEqual([st.enabled, st.logged_in], [true, false]);
  assert.strictEqual(t.net.calls.length, 0);
});

function plCfg() {
  return {
    userPlaylist: { code: 200, playlist: [
      { id: 7001, name: 'me喜欢的音乐', trackCount: 3, specialType: 5, subscribed: false, creator: { userId: 555, nickname: 'me' } },
      { id: 7002, name: '通勤', trackCount: 1005, specialType: 0, subscribed: false, creator: { userId: 555, nickname: 'me' } },
      { id: 7003, name: '空的', trackCount: 0, specialType: 0, subscribed: false, creator: { userId: 555 } },
      { id: 7004, name: '我喜欢', trackCount: 9, specialType: 0, subscribed: true, creator: { userId: 999, nickname: '别人' } },
      { id: 7005, name: '别人喜欢的音乐', trackCount: 4, specialType: 5, subscribed: true, creator: { userId: 888, nickname: '路人' } },
    ] },
    tracks: {
      7001: [LIB[101], LIB[201], N(401, '别的歌', ['乙', '丙'], 200)],
      7002: Array.from({ length: 1005 }, (_, i) => N(10000 + i, '歌' + i, ['丁'], 180)),
    },
  };
}

test('playlists:「我喜欢」第一、自建、收藏;别人的「喜欢的音乐」算收藏', async () => {
  const t = setup({ cfg: plCfg() });
  const r = await t.ne.playlists();
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(r.playlists, [
    { id: '7001', name: '我喜欢', count: 3, kind: 'liked', owner: '' },
    { id: '7002', name: '通勤', count: 1005, kind: 'mine', owner: '' },
    { id: '7004', name: '我喜欢', count: 9, kind: 'fav', owner: '别人' },
    { id: '7005', name: '别人喜欢的音乐', count: 4, kind: 'fav', owner: '路人' },
  ]);
  assert.strictEqual(t.net.api('/user/playlist')[0].q.get('uid'), '555');
});

test('playlistPage:「我喜欢」用自己的;分页拉全;筛选;随机', async () => {
  const t = setup({ cfg: plCfg() });
  let r = await t.ne.playlistPage('我喜欢');
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(r.playlist, { id: '7001', name: '我喜欢', count: 3 });
  assert.deepStrictEqual(r.songs[2], { id: 'ne-401', name: '别的歌', artist: '乙, 丙', interval: 200 });

  r = await t.ne.playlistPage('通勤', { offset: 1000, limit: 30 });
  assert.deepStrictEqual([r.total, r.songs.length, r.songs[0].id], [1005, 5, 'ne-11000']);
  assert.deepStrictEqual(t.net.api('/playlist/track/all').filter((c) => c.q.get('id') === '7002').map((c) => c.q.get('offset')), ['0', '1000']);

  r = await t.ne.playlistPage('ne-7001', { q: '丙' });
  assert.deepStrictEqual([r.total, r.songs[0].id], [1, 'ne-401']);

  r = await t.ne.playlistPage('通勤', { shuffle: true, limit: 7 });
  assert.strictEqual(new Set(r.songs.map((x) => x.id)).size, 7);

  t.net.reset();
  await t.ne.playlistPage('7002');
  assert.strictEqual(t.net.api('/playlist/track/all').length, 0);   // 6 小时存盘缓存

  r = await t.ne.playlistPage('健身');
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /现有的:我喜欢\(3\)、通勤\(1005\)/);
});

test('歌单:没登录 → login', async () => {
  let t = setup({ cfg: Object.assign(plCfg(), { loggedOut: true }) });
  let r = await t.ne.playlists();
  assert.deepStrictEqual([r.ok, r.login], [false, true]);
  t = setup({ cookie: 'NMTID=1', cfg: plCfg() });
  r = await t.ne.playlistPage('我喜欢');
  assert.deepStrictEqual([r.ok, r.login], [false, true]);
});

test('serve + 待下 + m4a + 只认网易云音频服务器', async () => {
  const t = setup({ cfg: { search: { '晴天': [101], '七里香': [301] },
    urls: { 101: { exhigh: 'full' }, 201: { exhigh: 'm4a' }, 301: { exhigh: 'evil' } } } });
  const first = await t.ne.fetchSong('晴天');
  assert.strictEqual(first.ok, true);
  const bad = await t.ne.fetchSong('七里香');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.msg, /允许的音频服务器/);

  t.ne.addPending([{ id: 'ne-201', name: '稻香', artist: '周杰伦', interval: 223 }, { id: 'abc' }], 'ne-101');
  assert.ok(await waitFor(() => fs.existsSync(path.join(t.cacheDir, '201.m4a'))));
  assert.strictEqual(t.ne.urlFor('ne-201'), '/api/ne/201.mp3');
  assert.strictEqual(t.ne.urlFor('ne-abc'), '');

  const { srv, base } = await startServer((req, res, n) => t.ne.serve(req, res, n));
  try {
    let res = await fetch(base + '?n=201.mp3', { headers: { Range: 'bytes=10-19' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-type'), 'audio/mp4');
    assert.strictEqual(res.headers.get('content-range'), 'bytes 10-19/' + SONG);
    assert.strictEqual((await res.arrayBuffer()).byteLength, 10);
    for (const n of ['999.mp3', 'qingtian1.mp3', '../101.mp3', '101.mp3/..', 'index.json']) {
      res = await fetch(base + '?n=' + encodeURIComponent(n));
      assert.strictEqual(res.status, 404, n);
      await res.arrayBuffer();
    }
  } finally { srv.close(); }
  assert.deepStrictEqual(t.ne.listCached().map((x) => x.id), ['ne-201', 'ne-101']);
});
