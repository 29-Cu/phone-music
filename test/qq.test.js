'use strict';

// QQ 音乐音源 + 共用缓存层的离线测试:fetch 全部是假的,不连外网。
// 跑:node --test test/qq.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createQQ, LOGIN_MSG } = require('../server/sources/qq.js');
const M = require('../server/sources/match.js');

const SONG = 64 * 1024; // 假音频大小(要大于缓存层的 50KB 下限)

function audio(seed, size) {
  const b = Buffer.alloc(size || SONG);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7 + seed.charCodeAt(0)) & 0xff;
  return b;
}

function json(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

const ROOTS = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qqtest-'));
  ROOTS.push(d);
  return d;
}
test.after(() => { for (const d of ROOTS) fs.rmSync(d, { recursive: true, force: true }); });

function setup(o) {
  o = o || {};
  const root = tmpdir();
  const cookieFile = path.join(root, 'cookie.txt');
  const metaFile = path.join(root, 'meta.json');
  if (o.cookie !== null) fs.writeFileSync(cookieFile, o.cookie || 'uin=o0012345; qm_keyst=TESTKEY; other=1');
  fs.writeFileSync(metaFile, JSON.stringify({ grabbed_at: 1, key_expires: o.expires || Math.floor(Date.now() / 1000) + 86400 }));
  const net = mockQQ(o.cfg || {});
  const logs = [];
  const qq = createQQ({
    cookieFile, metaFile,
    cacheDir: path.join(root, 'cache'),
    playlistCacheDir: path.join(root, 'playlists'),
    maxCacheBytes: o.maxCacheBytes,
    fetch: net,
    log: (m) => logs.push(m),
  });
  return { root, cookieFile, metaFile, net, qq, logs, cacheDir: path.join(root, 'cache') };
}

// 假的 QQ 音乐:cfg.songs 是曲库;cfg.playable 里列哪些 mid 的哪些档位有链接
function mockQQ(cfg) {
  const songs = cfg.songs || {};
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const call = { host: u.hostname, path: u.pathname, url: u, init, kind: '' };
    calls.push(call);
    if (u.hostname === 'u.y.qq.com') {
      const req = JSON.parse(u.searchParams.get('data')).req_0;
      call.param = req.param;
      if (req.module === 'music.search.SearchCgiService') {
        call.kind = 'desktop';
        if (cfg.desktop) return cfg.desktop(req.param);
        const list = (cfg.search && cfg.search[req.param.query]) || [];
        return json({ req_0: { code: 0, data: { body: { song: { list: list.map((m) => songs[m]) } } } } });
      }
      if (req.module === 'vkey.GetVkeyServer') {
        call.kind = 'vkey';
        if (cfg.vkeyCode != null) return json({ req_0: { code: cfg.vkeyCode, data: {} } });
        const mid = req.param.songmid[0];
        const ok = (cfg.playable && cfg.playable[mid]) || [];
        return json({ req_0: { code: 0, data: {
          sip: [cfg.sip || 'http://ws.stream.qqmusic.qq.com/'],
          midurlinfo: req.param.filename.map((f) => ({
            filename: f, songmid: mid,
            purl: ok.includes(f.slice(0, 4)) ? f + '?vkey=V' : '',
            result: ok.includes(f.slice(0, 4)) ? 0 : 104003,
          })),
        } } });
      }
      if (req.module === 'music.pf_song_detail_svr') {
        call.kind = 'detail';
        const s = songs[req.param.song_mid];
        return json({ req_0: { code: 0, data: { track_info: s || {} } } });
      }
    }
    if (u.pathname.endsWith('/client_search_cp')) {
      call.kind = 'legacy';
      const list = (cfg.legacy && cfg.legacy[u.searchParams.get('w')]) || [];
      return json({ code: 0, data: { song: { list: list.map((m) => songs[m]) } } });
    }
    if (u.pathname.endsWith('/fcg_user_created_diss')) { call.kind = 'created'; return json(cfg.created || { code: 0, data: { disslist: [] } }); }
    if (u.pathname.endsWith('/fcg_get_profile_order_asset.fcg')) { call.kind = 'fav'; return json(cfg.fav || { code: 0, data: { cdlist: [] } }); }
    if (u.pathname.endsWith('/fcg_ucc_getcdinfo_byids_cp.fcg')) {
      call.kind = 'cdinfo';
      const tid = u.searchParams.get('disstid');
      const begin = Number(u.searchParams.get('song_begin'));
      const all = (cfg.playlistSongs && cfg.playlistSongs[tid]) || [];
      const text = JSON.stringify({ code: 0, cdlist: [{ total_song_num: all.length, songlist: all.slice(begin, begin + 1000) }] });
      return new Response(cfg.jsonp ? 'jsonCallback(' + text + ')' : text);
    }
    if (/\.stream\.qqmusic\.qq\.com$|\.tc\.qq\.com$|example\.com$/.test(u.hostname)) {
      call.kind = 'cdn';
      call.file = u.pathname.slice(1);
      return new Response(audio(call.file.slice(4), cfg.size));
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  fn.kinds = () => calls.map((c) => c.kind);
  fn.reset = () => { calls.length = 0; };
  return fn;
}

function S(mid, name, singers, interval) {
  return { mid, name, singer: singers.map((n) => ({ name: n })), interval, album: { mid: 'al' } };
}

const LIB = {
  qingtian1: S('qingtian1', '晴天', ['周杰伦'], 269),
  qingtian2: S('qingtian2', '晴天', ['周杰伦'], 270),
  qingtianB: S('qingtianB', '晴天', ['别人'], 200),
  qingtianL: S('qingtianL', '晴天 (Live)', ['周杰伦'], 300),
  daoxiang1: S('daoxiang1', '稻香', ['周杰伦'], 223),
  qilixiang: S('qilixiang', '七里香', ['周杰伦'], 299),
  yequ00001: S('yequ00001', '夜曲', ['周杰伦'], 226),
  shortclip: S('shortclip', '晴天', ['周杰伦'], 20),
};

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const n = new URL(req.url, 'http://x').searchParams.get('n');
      handler(req, res, n);
    });
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

// ── 打分 / 挑版本 ──

test('score: 歌名、歌手、时长的权重', () => {
  const want = ['晴天', ['周杰伦'], 269];
  assert.strictEqual(M.score(...want, { name: '晴天', artists: ['周杰伦'], interval: 269 }), 7);
  assert.strictEqual(M.score(...want, { name: '晴天', artists: ['周杰伦'], interval: 275 }), 6);       // 差 6 秒 +1
  assert.strictEqual(M.score(...want, { name: '晴天', artists: ['周杰伦'], interval: 289 }), 5);       // 差 20 秒 0
  assert.strictEqual(M.score(...want, { name: '晴天 (Live)', artists: ['周杰伦'], interval: 300 }), 2); // 去括号一致 2 + 歌手 2 - 时长 2
  assert.strictEqual(M.score('晴天', [], 0, { name: '晴天娃娃', artists: [], interval: 0 }), 1);        // 包含 1
  assert.strictEqual(M.score('晴天', ['周杰伦'], 0, { name: '稻香', artists: ['周杰伦'], interval: 0 }), -1);
  assert.strictEqual(M.score('晴天', ['周杰伦'], 0, { name: '晴天', artists: ['周杰伦'], interval: 20 }), -1); // 短于 30 秒
  assert.strictEqual(M.score('晴天', ['周杰伦', 'X'], 0, { name: '晴天', artists: ['周杰伦.'], interval: 0 }), 5); // 标点不算
  assert.strictEqual(M.score('', ['周杰伦'], 0, { name: '晴天', artists: [], interval: 0 }), -1);
});

test('pick: 最高分不到 4 视为没对上', () => {
  const [c1, s1] = M.pick('晴天', ['周杰伦'], 0, [{ name: '晴天', artists: ['别人'], interval: 200 }]);
  assert.strictEqual(c1, null);
  assert.strictEqual(s1, 3);
  const good = { name: '晴天', artists: ['周杰伦'], interval: 270 };
  const [c2, s2] = M.pick('晴天', ['周杰伦'], 269, [{ name: '晴天', artists: ['别人'], interval: 200 }, good]);
  assert.strictEqual(c2, good);
  assert.strictEqual(s2, 7);
  assert.deepStrictEqual(M.pick('晴天', [], 0, []), [null, -1]);
});

test('alternatives: 只要 ≥4 分的,按分数排,最多 3 个', () => {
  const cands = [
    { id: 'a', name: '晴天', artists: ['别人'], interval: 200 },     // 1
    { id: 'b', name: '晴天', artists: ['周杰伦'], interval: 280 },    // 3+2+0=5
    { id: 'c', name: '晴天', artists: ['周杰伦'], interval: 269 },    // 7
    { id: 'd', name: '晴天', artists: ['周杰伦'], interval: 275 },    // 6
    { id: 'e', name: '晴天', artists: ['周杰伦'], interval: 270 },    // 7
  ];
  assert.deepStrictEqual(M.alternatives('晴天', ['周杰伦'], 269, cands).map((c) => c.id), ['c', 'e', 'd']);
});

test('findPlaylist: 「我喜欢」指向自己的,不被收藏的同名歌单抢走', () => {
  const pls = [
    { id: '1', name: '我喜欢', count: 3, kind: 'liked', owner: '' },
    { id: '2', name: '开车听', count: 5, kind: 'mine', owner: '' },
    { id: '3', name: '我喜欢', count: 9, kind: 'fav', owner: '别人' },
    { id: '4', name: '深夜 Lo-Fi', count: 9, kind: 'fav', owner: '别人' },
  ];
  assert.strictEqual(M.findPlaylist(pls, '红心').id, '1');
  assert.strictEqual(M.findPlaylist(pls, 'Liked').id, '1');
  assert.strictEqual(M.findPlaylist(pls, '3').id, '3');
  assert.strictEqual(M.findPlaylist(pls, '开车').id, '2');
  assert.strictEqual(M.findPlaylist(pls, 'lofi').id, '4');
  assert.strictEqual(M.findPlaylist(pls, '健身'), null);
  assert.strictEqual(M.findPlaylist(pls, ''), null);
  assert.strictEqual(M.findPlaylist(pls.filter((p) => p.kind !== 'liked'), '我喜欢'), null);
});

test('pageSongs: 筛选、翻页、随机、limit 上下限', () => {
  const songs = Array.from({ length: 50 }, (_, i) => ({ name: '歌' + i, artists: [i % 2 ? '甲' : '乙'] }));
  assert.strictEqual(M.pageSongs(songs, { q: '甲' }).total, 25);
  const p = M.pageSongs(songs, { offset: 45, limit: 30 });
  assert.strictEqual(p.total, 50);
  assert.deepStrictEqual(p.songs.map((x) => x.name), ['歌45', '歌46', '歌47', '歌48', '歌49']);
  assert.strictEqual(M.pageSongs(songs, { limit: 0 }).songs.length, 30);
  assert.strictEqual(M.pageSongs(songs, { limit: 999 }).songs.length, 50);
  assert.strictEqual(M.pageSongs(songs, { limit: -3 }).songs.length, 1);
  const r = M.pageSongs(songs, { shuffle: true, limit: 10 });
  assert.strictEqual(r.songs.length, 10);
  assert.strictEqual(new Set(r.songs.map((x) => x.name)).size, 10);
});

// ── 搜索 / 取链接 ──

test('搜索:桌面接口回空列表时换老接口', async () => {
  const t = setup({ cfg: { songs: LIB, search: {}, legacy: { '晴天 周杰伦': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  const r = await t.qq.fetchSong('晴天 周杰伦');
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(t.net.kinds().slice(0, 2), ['desktop', 'legacy']);
  assert.strictEqual(r.track.mid, 'qingtian1');
  assert.strictEqual(r.track.id, 'qq-qingtian1');
  assert.strictEqual(r.track.title, '晴天 - 周杰伦');
  assert.strictEqual(r.track.url, '/api/qq/qingtian1.mp3');
  assert.strictEqual(r.track.duration, 269);
  assert.strictEqual(r.cached, false);
  assert.strictEqual(r.alt, false);
  assert.ok(fs.existsSync(r.track.file));
});

test('搜索:桌面接口出错(HTTP 500)也换老接口', async () => {
  const t = setup({ cfg: { songs: LIB, desktop: async () => new Response('busy', { status: 500 }),
    legacy: { '稻香': ['daoxiang1'] }, playable: { daoxiang1: ['M800'] } } });
  const r = await t.qq.fetchSong('稻香');
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.track.mid, 'daoxiang1');
});

test('取链接:一次要三档,顺序 320k → 128k → m4a,取第一个有的', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '稻香': ['daoxiang1'], '七里香': ['qilixiang'] },
    playable: { daoxiang1: ['M500', 'C400'], qilixiang: ['C400'] } } });
  const r = await t.qq.fetchSong('稻香');
  assert.strictEqual(r.ok, true, r.msg);
  const vk = t.net.calls.find((c) => c.kind === 'vkey');
  assert.deepStrictEqual(vk.param.filename, ['M800daoxiang1daoxiang1.mp3', 'M500daoxiang1daoxiang1.mp3', 'C400daoxiang1daoxiang1.m4a']);
  assert.strictEqual(vk.param.uin, '12345');
  assert.ok(String(vk.init.headers.Cookie).includes('qm_keyst='));
  const cdn = t.net.calls.find((c) => c.kind === 'cdn');
  assert.strictEqual(cdn.host, 'ws.stream.qqmusic.qq.com');
  assert.strictEqual(cdn.url.protocol, 'https:');
  assert.ok(cdn.file.startsWith('M500'));
  const ix = JSON.parse(fs.readFileSync(path.join(t.cacheDir, 'index.json'), 'utf8'));
  assert.strictEqual(ix.songs.daoxiang1.br, 128000);
  assert.strictEqual(ix.songs.daoxiang1.ext, 'mp3');

  const r2 = await t.qq.fetchSong('七里香');
  assert.strictEqual(r2.ok, true, r2.msg);
  assert.ok(r2.track.file.endsWith('qilixiang.m4a'));
  assert.strictEqual(r2.track.url, '/api/qq/qilixiang.mp3');   // 对外统一 .mp3,serve 按实际格式发
  const { srv, base } = await startServer((req, res, n) => t.qq.serve(req, res, n));
  try {
    const res = await fetch(base + '?n=qilixiang.mp3');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'audio/mp4');
    await res.arrayBuffer();
  } finally { srv.close(); }
});

test('resolve:第一条那一版放不了就往下试;others 不含选中的那首', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1', 'qingtian2', 'qingtianB', 'qingtianL', 'shortclip'] },
    playable: { qingtian2: ['M800'] } } });
  const r = await t.qq.fetchSong('晴天');
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.track.mid, 'qingtian2');
  assert.deepStrictEqual(r.others.map((x) => x.artist + '/' + x.interval), ['周杰伦/269', '别人/200', '周杰伦/300']);
  assert.ok(r.others.length <= 3);
  // 短于 30 秒的候选不进
  assert.ok(!t.net.calls.some((c) => c.kind === 'vkey' && c.param.songmid[0] === 'shortclip'));
});

test('resolve:4 条都放不了 → 报拿不到链接(不是登录过期)', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1', 'qingtian2', 'qingtianB', 'qingtianL'] }, playable: {} } });
  const r = await t.qq.fetchSong('晴天');
  assert.strictEqual(r.ok, false);
  assert.ok(!r.login);
  assert.match(r.msg, /104003/);
  assert.strictEqual(t.net.calls.filter((c) => c.kind === 'vkey').length, 4);
});

test('换版:这一版没权限,用歌单带的歌名歌手找同一首的别的版本(<4 分的不要)', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天 周杰伦': ['qingtian1', 'qingtianB', 'qingtianL', 'qingtian2'] },
    playable: { qingtianB: ['M800'], qingtianL: ['M800'], qingtian2: ['M800'] } } });
  const r = await t.qq.fetchMid('qq-qingtian1', { hint: { name: '晴天', artist: '周杰伦', interval: 269 } });
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.alt, true);
  assert.strictEqual(r.track.mid, 'qingtian1');                // 存在原歌号名下
  assert.ok(r.track.file.endsWith('qingtian1.mp3'));
  assert.strictEqual(t.net.calls.find((c) => c.kind === 'cdn').file, 'M800qingtian2qingtian2.mp3');
  assert.ok(!t.net.kinds().includes('detail'));                 // 有 hint 不用查详情
  const tried = t.net.calls.filter((c) => c.kind === 'vkey').map((c) => c.param.songmid[0]);
  assert.deepStrictEqual(tried, ['qingtian1', 'qingtian2']);    // 别人唱的、Live 版都没试
});

test('换版:没 hint 时先查详情拿歌名歌手', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天 周杰伦': ['qingtian1', 'qingtian2'] }, playable: { qingtian2: ['M800'] } } });
  const r = await t.qq.fetchMid('qingtian1');
  assert.strictEqual(r.ok, true, r.msg);
  assert.strictEqual(r.alt, true);
  assert.ok(t.net.kinds().includes('detail'));
  assert.strictEqual(r.track.title, '晴天 - 周杰伦');
});

test('换版:找不到 ≥4 分的替补 → 原样报拿不到', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天 周杰伦': ['qingtian1', 'qingtianB'] }, playable: { qingtianB: ['M800'] } } });
  const r = await t.qq.fetchMid('qingtian1', { hint: { name: '晴天', artist: '周杰伦', interval: 269 } });
  assert.strictEqual(r.ok, false);
  assert.ok(!r.login);
});

test('fetchMid:歌号格式不对', async () => {
  const t = setup({ cfg: { songs: LIB } });
  assert.strictEqual((await t.qq.fetchMid('../etc')).ok, false);
  assert.strictEqual((await t.qq.fetchMid('qq-短')).ok, false);
  assert.strictEqual(t.net.calls.length, 0);
});

test('缓存命中:同一句再点不再问 QQ;歌号也能命中', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天 周杰伦': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  assert.strictEqual((await t.qq.fetchSong('晴天 周杰伦')).ok, true);
  t.net.reset();
  for (const q of ['晴天 周杰伦', '周杰伦 晴天', '晴天', '《晴天》周杰伦']) {
    const r = await t.qq.fetchSong(q);
    assert.strictEqual(r.ok, true, q);
    assert.strictEqual(r.cached, true, q);
  }
  const r2 = await t.qq.fetchMid('qingtian1');
  assert.strictEqual(r2.cached, true);
  assert.strictEqual(t.net.calls.length, 0);
  assert.deepStrictEqual(t.qq.listCached(), [{ id: 'qq-qingtian1', mid: 'qingtian1', title: '晴天 - 周杰伦', duration: 269 }]);
});

test('只从 QQ 的音频服务器下载', async () => {
  const t = setup({ cfg: { songs: LIB, sip: 'http://cdn.example.com/', search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  const r = await t.qq.fetchSong('晴天');
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /允许的音频服务器/);
  assert.ok(!t.net.kinds().includes('cdn'));
});

test('下下来太小(不是整首)不进缓存', async () => {
  const t = setup({ cfg: { songs: LIB, size: 1000, search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  const r = await t.qq.fetchSong('晴天');
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /太小/);
  assert.deepStrictEqual(fs.readdirSync(t.cacheDir).filter((n) => !n.startsWith('index')), []);
});

// ── 缓存上限 ──

test('缓存超上限:按 mtime 删最久没放的,刚存的不删;放一次算新', async () => {
  const lib = Object.assign({}, LIB);
  const songs = ['daoxiang1', 'qilixiang', 'yequ00001', 'qingtian1'];
  const search = {};
  const playable = {};
  for (const m of songs) { search[lib[m].name] = [m]; playable[m] = ['M800']; }
  const t = setup({ maxCacheBytes: 150 * 1024, cfg: { songs: lib, search, playable } });
  const fp = (m) => path.join(t.cacheDir, m + '.mp3');
  const age = (m, s) => { const d = new Date(Date.now() - s * 1000); fs.utimesSync(fp(m), d, d); };

  assert.strictEqual((await t.qq.fetchSong('稻香')).ok, true);
  age('daoxiang1', 3000);
  assert.strictEqual((await t.qq.fetchSong('七里香')).ok, true);
  age('qilixiang', 2000);
  assert.strictEqual((await t.qq.fetchSong('夜曲')).ok, true);       // 3 × 64KB > 150KB → 删最旧的稻香
  assert.ok(!fs.existsSync(fp('daoxiang1')));
  assert.ok(fs.existsSync(fp('qilixiang')) && fs.existsSync(fp('yequ00001')));
  assert.deepStrictEqual(t.qq.listCached().map((x) => x.mid), ['yequ00001', 'qilixiang']);   // 新的在前

  age('yequ00001', 1000);
  age('qilixiang', 2000);
  const { srv, base } = await startServer((req, res, n) => t.qq.serve(req, res, n));
  try {
    const res = await fetch(base + '?n=qilixiang.mp3');               // 放一次七里香 → 它变成最新
    assert.strictEqual(res.status, 200);
    await res.arrayBuffer();
  } finally { srv.close(); }
  assert.strictEqual((await t.qq.fetchSong('晴天')).ok, true);       // 再超 → 删夜曲
  assert.ok(!fs.existsSync(fp('yequ00001')));
  assert.ok(fs.existsSync(fp('qilixiang')) && fs.existsSync(fp('qingtian1')));
  const ix = JSON.parse(fs.readFileSync(path.join(t.cacheDir, 'index.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(ix.songs).sort(), ['qilixiang', 'qingtian1']);
});

test('缓存目录 700、文件 600', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  const r = await t.qq.fetchSong('晴天');
  assert.strictEqual(fs.statSync(t.cacheDir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(r.track.file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(t.cacheDir, 'index.json')).mode & 0o777, 0o600);
});

// ── serve ──

test('serve:整首 200、Range 206、后缀 Range、越界 416、HEAD、非 GET 405', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  const r = await t.qq.fetchSong('晴天');
  const body = fs.readFileSync(r.track.file);
  const { srv, base } = await startServer((req, res, n) => t.qq.serve(req, res, n));
  try {
    let res = await fetch(base + '?n=qingtian1.mp3');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(res.headers.get('content-length'), String(SONG));
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body));

    res = await fetch(base + '?n=qingtian1.mp3', { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), 'bytes 100-199/' + SONG);
    assert.strictEqual(res.headers.get('content-length'), '100');
    assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body.subarray(100, 200)));

    res = await fetch(base + '?n=qingtian1.mp3', { headers: { Range: 'bytes=65000-' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), 'bytes 65000-' + (SONG - 1) + '/' + SONG);
    assert.strictEqual((await res.arrayBuffer()).byteLength, SONG - 65000);

    res = await fetch(base + '?n=qingtian1.mp3', { headers: { Range: 'bytes=-10' } });
    assert.strictEqual(res.status, 206);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(body.subarray(SONG - 10)));

    res = await fetch(base + '?n=qingtian1.mp3', { headers: { Range: 'bytes=0-999999' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), 'bytes 0-' + (SONG - 1) + '/' + SONG);
    await res.arrayBuffer();

    res = await fetch(base + '?n=qingtian1.mp3', { headers: { Range: 'bytes=999999-' } });
    assert.strictEqual(res.status, 416);
    assert.strictEqual(res.headers.get('content-range'), 'bytes */' + SONG);
    await res.arrayBuffer();

    res = await fetch(base + '?n=qingtian1.mp3', { headers: { Range: 'bytes=0-1,5-9' } });   // 多段当没写
    assert.strictEqual(res.status, 200);
    await res.arrayBuffer();

    res = await fetch(base + '?n=qingtian1.m4a', { method: 'HEAD' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), String(SONG));

    res = await fetch(base + '?n=qingtian1.mp3', { method: 'POST' });
    assert.strictEqual(res.status, 405);
    await res.arrayBuffer();
  } finally { srv.close(); }
});

test('serve:没缓存也没排进歌单 → 404;各种路径穿越写法一律 404', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  await t.qq.fetchSong('晴天');
  fs.writeFileSync(path.join(t.root, 'secret.mp3'), 'x');
  const { srv, base } = await startServer((req, res, n) => t.qq.serve(req, res, n));
  const bad = ['daoxiang1.mp3', 'index.json', '../index.json', '../cache/qingtian1.mp3', '..%2Fsecret.mp3', '../secret.mp3',
    'qingtian1.mp3/..', './qingtian1.mp3', 'qingtian1.mp3.', 'qingtian1.txt', 'qingtian1', '.mp3', 'qingtian1.mp3\0',
    'qingtian1.MP3', ' qingtian1.mp3', 'a/b/qingtian1.mp3', 'qingtian1.mp3?x=1', ''];
  try {
    for (const n of bad) {
      const res = await fetch(base + '?n=' + encodeURIComponent(n));
      assert.strictEqual(res.status, 404, JSON.stringify(n));
      await res.arrayBuffer();
    }
    const res = await fetch(base);           // 没 name(null)
    assert.strictEqual(res.status, 404);
    await res.arrayBuffer();
  } finally { srv.close(); }
  assert.ok(!t.net.kinds().includes('detail'));
});

test('serve:歌单里排着的歌,来取时才下;放到第 i 首时预下第 i+1 首', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1'] },
    playable: { qingtian1: ['M800'], daoxiang1: ['M800'], qilixiang: ['M800'], yequ00001: ['M800'] } } });
  const first = await t.qq.fetchSong('晴天');
  assert.strictEqual(first.ok, true);
  const fp = (m) => path.join(t.cacheDir, m + '.mp3');
  t.qq.addPending([
    { mid: 'daoxiang1', name: '稻香', artist: '周杰伦', interval: 223 },
    { mid: 'qilixiang', name: '七里香', artist: '周杰伦', interval: 299 },
    { id: 'qq-yequ00001', name: '夜曲', artist: '周杰伦', interval: 226 },
    { mid: '../../bad', name: 'x' },
  ], 'qingtian1');
  // 正在放第一首 → 第二首马上开始预下
  assert.ok(await waitFor(() => fs.existsSync(fp('daoxiang1'))), '第二首应已预下');
  assert.ok(!fs.existsSync(fp('qilixiang')));
  assert.ok(!fs.existsSync(fp('yequ00001')));

  const { srv, base } = await startServer((req, res, n) => t.qq.serve(req, res, n));
  try {
    // 直接跳到第三首:当场下载再发
    let res = await fetch(base + '?n=qilixiang.mp3', { headers: { Range: 'bytes=0-9' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), 'bytes 0-9/' + SONG);
    await res.arrayBuffer();
    assert.ok(fs.existsSync(fp('qilixiang')));
    // 放了第三首 → 第四首预下
    assert.ok(await waitFor(() => fs.existsSync(fp('yequ00001'))), '第四首应已预下');
    res = await fetch(base + '?n=yequ00001.mp3');
    assert.strictEqual(res.status, 200);
    await res.arrayBuffer();
  } finally { srv.close(); }
  const idx = JSON.parse(fs.readFileSync(path.join(t.cacheDir, 'index.json'), 'utf8')).songs;
  assert.strictEqual(idx.qilixiang.name, '七里香');
  assert.deepStrictEqual(idx.qilixiang.artists, ['周杰伦']);
  assert.ok(!t.net.kinds().includes('detail'));   // 歌单带了歌名,不用查详情
  // 同一首只下一次
  assert.strictEqual(t.net.calls.filter((c) => c.kind === 'cdn' && c.file.includes('qilixiang')).length, 1);
});

test('serve:排进歌单但登录过期 → 503', async () => {
  const t = setup({ cookie: 'uin=o1; other=1', cfg: { songs: LIB } });
  t.qq.addPending([{ mid: 'daoxiang1', name: '稻香', artist: '周杰伦', interval: 223 }], 'qingtian1');
  const { srv, base } = await startServer((req, res, n) => t.qq.serve(req, res, n));
  try {
    const res = await fetch(base + '?n=daoxiang1.mp3');
    assert.strictEqual(res.status, 503);
    await res.arrayBuffer();
  } finally { srv.close(); }
  assert.ok(t.logs.some((l) => l.includes('daoxiang1')));
  assert.ok(!t.logs.some((l) => l.includes('uin=')));
});

// ── 登录 ──

test('登录:没 cookie 文件 / 没登录 key / 接口整体报错 / meta 说过期', async () => {
  let t = setup({ cookie: null, cfg: { songs: LIB } });
  assert.strictEqual(t.qq.enabled(), false);
  let st = await t.qq.status();
  assert.deepStrictEqual([st.enabled, st.logged_in], [false, false]);
  let r = await t.qq.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.login, r.msg], [false, true, LOGIN_MSG]);
  assert.match(LOGIN_MSG, /tools\/qq-login\.js/);

  t = setup({ cookie: 'uin=o1; foo=bar', cfg: { songs: LIB, search: { '晴天': ['qingtian1'] } } });
  assert.strictEqual(t.qq.enabled(), true);
  st = await t.qq.status();
  assert.deepStrictEqual([st.enabled, st.logged_in], [true, false]);
  r = await t.qq.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.login], [false, true]);
  assert.ok(!t.net.kinds().includes('vkey'));

  t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, vkeyCode: 1000 } });
  st = await t.qq.status();
  assert.strictEqual(st.logged_in, true);
  assert.ok(st.expires_at > 0);
  r = await t.qq.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.login], [false, true]);
  st = await t.qq.status();                            // 刚判过过期,status 跟着报过期
  assert.strictEqual(st.logged_in, false);

  t = setup({ expires: Math.floor(Date.now() / 1000) - 60, cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, playable: {} } });
  st = await t.qq.status();
  assert.strictEqual(st.logged_in, false);
  r = await t.qq.fetchSong('晴天');
  assert.deepStrictEqual([r.ok, r.login], [false, true]);
});

test('登录:cookie 文件更新后不用重启就生效;已缓存的歌没登录也能放', async () => {
  const t = setup({ cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  assert.strictEqual((await t.qq.fetchSong('晴天')).ok, true);
  fs.writeFileSync(t.cookieFile, 'uin=o1; nothing=here!');
  assert.strictEqual((await t.qq.status()).logged_in, false);
  const r = await t.qq.fetchSong('晴天');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cached, true);
  fs.writeFileSync(t.cookieFile, 'uin=o1; qm_keyst=NEW');
  assert.strictEqual((await t.qq.status()).logged_in, true);
});

test('返回给调用方的内容里没有 cookie', async () => {
  const t = setup({ cookie: 'uin=o0012345; qm_keyst=SECRETVALUE', cfg: { songs: LIB, search: { '晴天': ['qingtian1'] }, playable: { qingtian1: ['M800'] } } });
  const out = JSON.stringify([await t.qq.status(), await t.qq.fetchSong('晴天'), await t.qq.playlists(), t.qq.listCached()]);
  assert.ok(!out.includes('SECRETVALUE'));
  assert.ok(!fs.readFileSync(path.join(t.cacheDir, 'index.json'), 'utf8').includes('SECRETVALUE'));
});

// ── 歌单 ──

function plCfg(extra) {
  const pl = {};
  pl['900201'] = [S('qingtian1', '晴天', ['周杰伦'], 269), S('daoxiang1', '稻香', ['周杰伦', '某乐队'], 223), S('xx0000001', '别的歌', ['乙'], 200)];
  pl['900111'] = Array.from({ length: 1500 }, (_, i) => S('big' + String(i).padStart(6, '0'), '歌' + i, ['丙'], 180));
  return Object.assign({
    songs: LIB,
    created: { code: 0, data: { disslist: [
      { tid: 900111, diss_name: '自建A', song_cnt: 1500, dirid: 1 },
      { tid: 900201, diss_name: '随便什么名字', song_cnt: 3, dirid: 201 },
      { tid: 0, diss_name: '无效', song_cnt: 3, dirid: 2 },
      { tid: 900333, diss_name: '空歌单', song_cnt: 0, dirid: 3 },
    ] } },
    fav: { code: 0, data: { cdlist: [{ dissid: 900444, dissname: '我喜欢', songnum: 9, nickname: '别人' }] } },
    playlistSongs: pl,
  }, extra || {});
}

test('playlists:「我喜欢」排第一,然后自建、收藏;空的和无效的不要;10 分钟内不重复拉', async () => {
  const t = setup({ cfg: plCfg() });
  const r = await t.qq.playlists();
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(r.playlists, [
    { id: '900201', name: '我喜欢', count: 3, kind: 'liked', owner: '' },
    { id: '900111', name: '自建A', count: 1500, kind: 'mine', owner: '' },
    { id: '900444', name: '我喜欢', count: 9, kind: 'fav', owner: '别人' },
  ]);
  const created = t.net.calls.find((c) => c.kind === 'created');
  assert.strictEqual(created.url.searchParams.get('hostuin'), '12345');
  t.net.reset();
  await t.qq.playlists();
  assert.strictEqual(t.net.calls.length, 0);
});

test('playlistPage:「我喜欢」用自己的;筛选;翻页;找不到列出现有的', async () => {
  const t = setup({ cfg: plCfg({ jsonp: true }) });
  let r = await t.qq.playlistPage('我喜欢');
  assert.strictEqual(r.ok, true, r.msg);
  assert.deepStrictEqual(r.playlist, { id: '900201', name: '我喜欢', count: 3 });
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(r.songs[1], { id: 'qq-daoxiang1', mid: 'daoxiang1', name: '稻香', artist: '周杰伦, 某乐队', interval: 223 });

  r = await t.qq.playlistPage('我喜欢', { q: '某乐队' });
  assert.deepStrictEqual([r.total, r.songs.map((x) => x.mid)], [1, ['daoxiang1']]);

  r = await t.qq.playlistPage('自建', { offset: 1490, limit: 30 });
  assert.strictEqual(r.total, 1500);
  assert.strictEqual(r.songs.length, 10);
  const pages = t.net.calls.filter((c) => c.kind === 'cdinfo' && c.url.searchParams.get('disstid') === '900111')
    .map((c) => c.url.searchParams.get('song_begin'));
  assert.deepStrictEqual(pages, ['0', '1000']);

  r = await t.qq.playlistPage('自建A', { shuffle: true, limit: 5 });
  assert.strictEqual(r.songs.length, 5);

  t.net.reset();
  r = await t.qq.playlistPage('900201');                          // 6 小时存盘缓存
  assert.strictEqual(r.ok, true);
  assert.ok(!t.net.kinds().includes('cdinfo'));
  const plFile = path.join(t.root, 'playlists', '900201.json');
  assert.strictEqual(fs.statSync(plFile).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(plFile)).mode & 0o777, 0o700);

  r = await t.qq.playlistPage('健身房');
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /现有的:我喜欢\(3\)、自建A\(1500\)、我喜欢\(9\)/);
});

test('歌单:没登录 → login', async () => {
  const t = setup({ cookie: 'uin=o1', cfg: plCfg() });
  const r = await t.qq.playlists();
  assert.deepStrictEqual([r.ok, r.login], [false, true]);
  const r2 = await t.qq.playlistPage('我喜欢');
  assert.deepStrictEqual([r2.ok, r2.login], [false, true]);
  const t2 = setup({ cfg: plCfg({ created: { code: 1000, msg: 'no login' } }) });
  const r3 = await t2.qq.playlists();
  assert.deepStrictEqual([r3.ok, r3.login], [false, true]);
});

test('urlFor', () => {
  const t = setup({ cfg: {} });
  assert.strictEqual(t.qq.urlFor('qq-qingtian1'), '/api/qq/qingtian1.mp3');
  assert.strictEqual(t.qq.urlFor('qingtian1'), '/api/qq/qingtian1.mp3');
  assert.strictEqual(t.qq.urlFor('../x'), '');
});
