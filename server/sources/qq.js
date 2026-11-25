'use strict';

// QQ 音乐音源:用你自己的 QQ 音乐会员登录(cookie)搜歌、取播放链接、读你的歌单,
// 下到本机私有缓存里,给通话里的播放端放。只供自用,缓存的音频不能公开、不能转发。
//
// 登录:cookie.txt 由 tools/qq-login.js 从一个登录了 y.qq.com 的浏览器里取出来。
//       每次用都按文件变化重读,定时任务刷新以后不用重启。cookie 内容不打日志、不回给调用方。
//       meta.json(同一个工具写的,不含 cookie)记登录到期时间,用来判断「过期了」。
// 依赖:无(Node ≥18 自带的 fetch / fs / crypto / path)。

const fs = require('fs');
const path = require('path');
const { createCache, readJsonFresh, writeJsonAtomic } = require('./cache.js');
const M = require('./match.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com' };
const API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

// 音质档位:先 320k mp3,再 128k mp3,再 96k m4a(一次请求一起要,取第一个有的)
const TIERS = [['M800', 'mp3', 320000], ['M500', 'mp3', 128000], ['C400', 'm4a', 96000]];
const URL_TTL = 10 * 60 * 1000;      // 同一首的播放链接在内存里留 10 分钟(vkey 有时效)
const LIST_TTL = 10 * 60 * 1000;     // 歌单列表 10 分钟
const PL_TTL = 6 * 3600 * 1000;      // 歌单里的歌 6 小时(存盘)
const EXPIRED_HOLD = 10 * 60 * 1000; // 取链接时判过「登录过期」,status() 在这之后 10 分钟内照报过期
const MID_RE = /^[0-9A-Za-z]{8,24}$/;
const ID_PREFIX = 'qq-';

const LOGIN_MSG = 'QQ 音乐登录过期了(或者还没登录),现在放不了会员里的歌。' +
  '请在开着远程调试的那个浏览器里打开 y.qq.com 重新登录,然后再跑一次 node tools/qq-login.js 就好' +
  '(配了定时任务的话,浏览器里登录好之后几小时内会自动跟上)。';

class LoginError extends Error {}

function isCdnHost(host) {
  host = String(host || '').toLowerCase();
  return host.endsWith('.stream.qqmusic.qq.com') || host.endsWith('.tc.qq.com');
}

function stripMid(v) {
  const s = String(v || '').trim().replace(/^qq-/, '');
  return MID_RE.test(s) ? s : '';
}

function errMsg(e) {
  return M.cut(String((e && e.message) || e), 120);
}

function createQQ(opts) {
  opts = opts || {};
  const cookieFile = opts.cookieFile || '';
  const metaFile = opts.metaFile || (cookieFile ? path.join(path.dirname(cookieFile), 'meta.json') : '');
  const cacheDir = opts.cacheDir;
  const plDir = opts.playlistCacheDir || path.join(cacheDir, 'playlists');
  const doFetch = (...a) => (opts.fetch || globalThis.fetch)(...a);
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const ck = { sig: '', val: '' };
  const urls = new Map();            // mid → { t, res }
  const lastFail = { at: 0, why: '' };
  const plList = { at: 0, val: null };
  const plInflight = new Map();      // 歌单号 → Promise(同一个歌单同时只拉一次)

  // ── 登录 ──
  function cookie() {
    let st;
    try { st = fs.statSync(cookieFile); } catch (_) { return ''; }
    const sig = st.mtimeMs + ':' + st.size + ':' + st.ino;
    if (sig !== ck.sig) {
      try {
        ck.val = fs.readFileSync(cookieFile, 'utf8').trim();
        ck.sig = sig;
      } catch (_) { return ''; }
    }
    return ck.val;
  }

  function uin(c) {
    for (const name of ['uin', 'qqmusic_uin', 'wxuin']) {
      const m = new RegExp('(?:^|;\\s*)' + name + '=o?0*(\\d+)').exec(c);
      if (m) return m[1];
    }
    return '0';
  }

  function hasKey(c) {
    return /(?:^|;\s*)(?:qm_keyst|qqmusic_key)=[^;\s]/.test(c);
  }

  // 登录 key 的到期时间(unix 秒),不知道就 0
  function expiresAt() {
    try { return parseInt(JSON.parse(fs.readFileSync(metaFile, 'utf8')).key_expires, 10) || 0; } catch (_) { return 0; }
  }

  function fail(why, msg) {
    if (why === 'expired' || why === 'nologin') {
      lastFail.at = Date.now();
      lastFail.why = 'expired';
    }
    return { ok: false, why, msg };
  }

  // 内部结果 → 对外形状
  function outErr(r, fallback) {
    if (r && (r.why === 'expired' || r.why === 'nologin')) return { ok: false, login: true, msg: LOGIN_MSG };
    return { ok: false, msg: (r && r.msg) || fallback || 'QQ 音乐这首拿不到。' };
  }

  function enabled() {
    return !!cookie();
  }

  async function status() {
    const c = cookie();
    const exp = expiresAt();
    if (!c) return { enabled: false, logged_in: false, expires_at: 0, msg: LOGIN_MSG };
    if (!hasKey(c)) return { enabled: true, logged_in: false, expires_at: exp, msg: LOGIN_MSG };
    const now = Date.now();
    let ok = true;
    if (exp && now / 1000 > exp) ok = false;
    else if (lastFail.why === 'expired' && now - lastFail.at < EXPIRED_HOLD) ok = false;
    if (!ok) return { enabled: true, logged_in: false, expires_at: exp, msg: LOGIN_MSG };
    const h = exp ? Math.round((exp - now / 1000) / 360) / 10 : 0;
    return {
      enabled: true,
      logged_in: true,
      expires_at: exp,
      msg: 'QQ 音乐已登录' + (exp ? ',登录大约 ' + h + ' 小时后到期' : '') + '。',
    };
  }

  // ── 请求 ──
  async function call(data, c) {
    const h = Object.assign({}, H);
    if (c) h.Cookie = c;
    const url = API + '?' + new URLSearchParams({ format: 'json', data: JSON.stringify(data) });
    const r = await doFetch(url, { headers: h, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('QQ 接口回 HTTP ' + r.status);
    return JSON.parse(await r.text());
  }

  async function getJson(url, referer) {
    const h = Object.assign({}, H, { Cookie: cookie(), Referer: referer || 'https://y.qq.com/' });
    const r = await doFetch(url, { headers: h, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('QQ 接口回 HTTP ' + r.status);
    let t = (await r.text()).trim();
    if (!t.startsWith('{')) {   // 有的接口回 JSONP:callback({...})
      const a = t.indexOf('{');
      const b = t.lastIndexOf('}');
      if (a < 0 || b < a) throw new Error('QQ 接口回的不是 JSON');
      t = t.slice(a, b + 1);
    }
    return JSON.parse(t);
  }

  function songOf(x) {
    return {
      mid: (x && x.mid) || '',
      name: (x && x.name) || '',
      artists: ((x && x.singer) || []).map((a) => (a && a.name) || ''),
      interval: Math.trunc(Number(x && x.interval)) || 0,
    };
  }

  async function searchOnce(query, n) {
    const d = await call({ req_0: { module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicDesktop',
      param: { query, num_per_page: n, page_num: 1, search_type: 0 } } }, null);
    const lst = (((((d || {}).req_0 || {}).data || {}).body || {}).song || {}).list || [];
    return lst.map(songOf).filter((x) => x.mid);
  }

  async function searchLegacy(query, n) {
    const u = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + new URLSearchParams({
      w: query, n: String(n), p: '1', format: 'json', cr: '1', new_json: '1' });
    const r = await doFetch(u, { headers: H, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('QQ 搜索回 HTTP ' + r.status);
    const d = JSON.parse(await r.text());
    const lst = (((d || {}).data || {}).song || {}).list || [];
    return lst.map(songOf).filter((x) => x.mid);
  }

  // 桌面版搜索接口会被限流成空列表;空了(或出错)换老的 client_search_cp,慢一点但稳
  async function search(query, n) {
    n = n || 10;
    let out = [];
    try { out = await searchOnce(query, n); } catch (_) { out = []; }
    if (out.length) return out;
    try { return await searchLegacy(query, n); } catch (_) { return []; }
  }

  // 按歌号取播放链接(可能抛网络错误)
  async function rawUrl(mid) {
    const now = Date.now();
    const hit = urls.get(mid);
    if (hit && now - hit.t < URL_TTL) return hit.res;
    const c = cookie();
    if (!c) return fail('nologin', LOGIN_MSG);
    if (!hasKey(c)) return fail('expired', LOGIN_MSG);
    const exp = expiresAt();
    const files = TIERS.map(([pre, ext]) => pre + mid + mid + '.' + ext);
    const guid = String(1e9 + Math.floor(Math.random() * 9e9));
    const d = await call({ req_0: { module: 'vkey.GetVkeyServer', method: 'CgiGetVkey', param: {
      guid, songmid: files.map(() => mid), songtype: files.map(() => 0),
      uin: uin(c), loginflag: 1, platform: '20', filename: files } } }, c);
    const req = (d && d.req_0) || {};
    const data = req.data || {};
    const sips = (data.sip || []).filter(Boolean);
    const infos = new Map();
    for (const i of data.midurlinfo || []) if (i) infos.set(i.filename, i);
    for (let k = 0; k < TIERS.length; k++) {
      const purl = (infos.get(files[k]) || {}).purl || '';
      if (purl && sips.length) {
        const s = String(sips[0]);
        const j = s.indexOf('://');
        const host = j >= 0 ? s.slice(j + 3) : s;
        const res = { ok: true, url: 'https://' + host + purl, br: TIERS[k][2], ext: TIERS[k][1], mid };
        urls.set(mid, { t: now, res });
        if (lastFail.why) lastFail.why = '';
        return res;
      }
    }
    const codes = [...new Set([...infos.values()].map((i) => String(i.result == null ? 'None' : i.result)))].sort();
    // 104003 = 没权限。登录还在、只是这首会员也放不了(数字专辑之类)也是这个码;
    // 所以只有在 meta 说已经过期、或者接口整体报错时才判「登录过期」
    if ((exp && Date.now() / 1000 > exp) || !(req.code === 0 || req.code == null)) return fail('expired', LOGIN_MSG);
    return fail('nourl', 'QQ 音乐这首拿不到播放链接(返回码 ' + codes.join(',') + ',可能是数字专辑/单独付费,或者登录过期)');
  }

  async function urlForMid(mid) {
    try { return await rawUrl(mid); } catch (e) { return { ok: false, why: 'error', msg: 'QQ 音乐出错: ' + errMsg(e) }; }
  }

  async function detail(mid) {
    const d = await call({ req_0: { module: 'music.pf_song_detail_svr', method: 'get_song_detail_yqq',
      param: { song_mid: mid, song_type: 0 } } }, null);
    const t = ((((d || {}).req_0 || {}).data || {}).track_info) || {};
    if (!t.name) return null;
    return {
      name: t.name || '',
      artists: (t.singer || []).map((a) => (a && a.name) || '').filter(Boolean),
      interval: Math.trunc(Number(t.interval)) || 0,
    };
  }

  // 那一版放不了(没权限)时,按歌名+歌手搜同一首的别的版本(分数 ≥4 的前 3 个)
  async function alts(name, artists, dur, exclude) {
    const q = (String(name || '') + ' ' + (artists[0] || '')).trim();
    const cands = await search(q, 10);
    return M.alternatives(name, artists, dur, cands.filter((c) => c.mid !== exclude));
  }

  // 按歌号取链接;这一版没权限(nourl)就找同一首的别的版本。换了版时带 alt={mid,name,artists,interval}
  async function urlWithAlt(mid, name, artists, dur) {
    const r = await urlForMid(mid);
    if (r.ok || r.why !== 'nourl') return r;
    try {
      if (name == null) {
        const d = (await detail(mid)) || {};
        name = d.name || '';
        artists = d.artists || [];
        dur = d.interval || 0;
      }
      if (!name) return r;
      for (const c of await alts(name, artists || [], dur, mid)) {
        const r2 = await urlForMid(c.mid);
        if (r2.ok) return Object.assign({}, r2, { alt: { mid: c.mid, name: c.name, artists: c.artists, interval: c.interval } });
      }
    } catch (_) {}
    return r;
  }

  // 歌单里的某一首:歌号 → 链接 + 歌名。hint = 歌单里带的歌名/歌手/时长,有它就不用再查一次详情
  async function resolveMid(mid, hint) {
    const hn = hint && hint.name ? String(hint.name) : '';
    const ha = hint ? M.splitArtists(hint.artists || hint.artist) : [];
    const hd = hint ? Number(hint.interval) || 0 : 0;
    const r = hn ? await urlWithAlt(mid, hn, ha, hd) : await urlWithAlt(mid);
    if (r.ok && r.alt) return Object.assign({}, r, { name: r.alt.name, artists: r.alt.artists, interval: r.alt.interval });
    if (r.ok) {
      if (hn) return Object.assign({}, r, { name: hn, artists: ha, interval: hd });
      try {
        const d = (await detail(mid)) || {};
        return Object.assign({}, r, { name: d.name || '', artists: d.artists || [], interval: d.interval || 0 });
      } catch (_) {}
    }
    return r;
  }

  // 一句「歌名 歌手」→ 搜索结果里第一条能放的(第一条那一版放不了就往下试,一共试 4 条)
  async function resolve(query) {
    try {
      if (!cookie()) return fail('nologin', LOGIN_MSG);
      const q = M.cut(String(query || '').trim(), 80);
      if (!q) return { ok: false, why: 'nomatch', msg: '没给歌名。' };
      const cands = (await search(q)).filter((c) => !c.interval || c.interval >= 30);
      if (!cands.length) return { ok: false, why: 'nomatch', msg: 'QQ 音乐上没搜到「' + q + '」。' };
      let c = cands[0];
      let r = null;
      for (const cc of cands.slice(0, 4)) {
        r = await rawUrl(cc.mid);
        if (r.ok || r.why !== 'nourl') { c = cc; break; }
      }
      if (r.ok) {
        r = Object.assign({}, r, {
          name: c.name, artists: c.artists, interval: c.interval,
          others: cands.filter((x) => x !== c).slice(0, 3)
            .map((x) => ({ name: x.name, artist: x.artists.join(', '), interval: x.interval })),
        });
      }
      return r;
    } catch (e) {
      return { ok: false, why: 'error', msg: 'QQ 音乐出错: ' + errMsg(e) };
    }
  }

  const cache = createCache({
    dir: cacheDir,
    maxBytes: opts.maxCacheBytes || 2 * 1024 ** 3,
    urlPrefix: opts.urlPrefix || '/api/qq/',
    keyPattern: '[0-9A-Za-z]{8,24}',
    idPrefix: ID_PREFIX,
    keyField: 'mid',
    label: 'qq',
    allowHost: isCdnHost,
    downloadHeaders: { Referer: 'https://y.qq.com/' },
    fetch: doFetch,
    log,
    resolveKey: async (mid, hint) => {
      const r = await resolveMid(mid, hint);
      return r.ok ? r : outErr(r);
    },
  });

  async function fetchSong(query) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, msg: '要给歌名(最好带上歌手),比如「月亮代表我的心 邓丽君」。' };
    cache.ensureDir();
    const hit = cache.findCached(q);
    if (hit) return cache.fetchKey(hit.key, null);
    const r = await resolve(q);
    if (!r.ok) return outErr(r, 'QQ 音乐上没找到「' + M.cut(q, 40) + '」。');
    return cache.store(r.mid, r, q, null);
  }

  // 按歌号拿一首。换了版(alt)也存在原歌号名下:歌单里排的是原歌号,播放端按它来取
  async function fetchMid(mid, o) {
    const m = stripMid(mid);
    if (!m) return { ok: false, msg: '歌号格式不对。' };
    const hint = o && o.hint ? o.hint : null;
    return cache.fetchKey(m, hint);
  }

  // ── 歌单(只读)──
  // 自建的(含「我喜欢」,dirid=201)+ 收藏的别人的歌单;「我喜欢」排第一,然后自建,然后收藏
  async function myPlaylists(fresh) {
    const now = Date.now();
    if (!fresh && plList.val && now - plList.at < LIST_TTL) return plList.val;
    const c = cookie();
    if (!c || !hasKey(c)) throw new LoginError(LOGIN_MSG);
    const u = uin(c);
    const out = [];
    const d = await getJson('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?' + new URLSearchParams({
      hostuin: u, sin: '0', size: '200', format: 'json', g_tk: '5381' }));
    if (!(d.code === 0 || d.code == null)) throw new LoginError(LOGIN_MSG);
    for (const x of (d.data || {}).disslist || []) {
      const tid = String(x.tid || '0');
      const cnt = parseInt(x.song_cnt, 10) || 0;
      if (tid === '0' || !cnt) continue;
      const liked = Number(x.dirid) === 201;
      out.push({ id: tid, name: liked ? '我喜欢' : (x.diss_name || ''), count: cnt, kind: liked ? 'liked' : 'mine', owner: '' });
    }
    try {
      const f = await getJson('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg?' + new URLSearchParams({
        ct: '20', cid: '205360956', userid: u, reqtype: '3', sin: '0', ein: '200', format: 'json' }));
      for (const x of (f.data || {}).cdlist || []) {
        if (!x.dissid) continue;
        out.push({ id: String(x.dissid), name: x.dissname || '', count: parseInt(x.songnum, 10) || 0, kind: 'fav', owner: x.nickname || '' });
      }
    } catch (_) {}
    const rank = { liked: 0, mine: 1, fav: 2 };
    out.sort((a, b) => rank[a.kind] - rank[b.kind]);
    plList.at = now;
    plList.val = out;
    return out;
  }

  function plFile(tid) {
    return path.join(plDir, String(tid).replace(/\D/g, '') + '.json');
  }

  // 整个歌单的歌 [{mid,name,artists,interval}],每页 1000 首、最多 1 万首,6 小时存盘缓存
  function playlistSongs(tid, fresh) {
    if (!/^\d+$/.test(String(tid))) return Promise.reject(new Error('歌单号不对'));
    const fp = plFile(tid);
    if (!fresh) {
      const hit = readJsonFresh(fp, PL_TTL);
      if (Array.isArray(hit)) return Promise.resolve(hit);
    }
    if (plInflight.has(tid)) return plInflight.get(tid);
    const p = (async () => {
      const songs = [];
      let begin = 0;
      let total = null;
      for (;;) {
        const d = await getJson('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?' + new URLSearchParams({
          type: '1', json: '1', utf8: '1', onlysong: '0', new_format: '1', disstid: String(tid),
          song_begin: String(begin), song_num: '1000', format: 'json', g_tk: '5381' }), 'https://y.qq.com/n/yqq/playlist');
        if (!(d.code === 0 || d.code == null)) {
          if (!songs.length) {
            if (!hasKey(cookie())) throw new LoginError(LOGIN_MSG);
            throw new Error('QQ 歌单接口回 code ' + d.code);
          }
          break;
        }
        const cd = (d.cdlist || [{}])[0] || {};
        if (total === null) total = parseInt(cd.total_song_num || cd.songnum, 10) || 0;
        const sl = cd.songlist || [];
        for (const x of sl) if (x && x.mid) songs.push(songOf(x));
        begin += 1000;
        if (!sl.length || begin >= (total || 0) || begin >= 10000) break;
      }
      writeJsonAtomic(fp, songs);
      return songs;
    })().finally(() => plInflight.delete(tid));
    plInflight.set(tid, p);
    return p;
  }

  function songView(x) {
    return { id: ID_PREFIX + x.mid, mid: x.mid, name: x.name, artist: x.artists.join(', '), interval: x.interval };
  }

  function loginOut() {
    fail('expired', LOGIN_MSG);
    return { ok: false, login: true, msg: LOGIN_MSG };
  }

  async function playlists() {
    try {
      const pls = await myPlaylists(false);
      return { ok: true, playlists: pls.map((p) => Object.assign({}, p)) };
    } catch (e) {
      if (e instanceof LoginError) return loginOut();
      return { ok: false, msg: 'QQ 歌单读取出错: ' + errMsg(e) };
    }
  }

  async function playlistPage(nameOrId, o) {
    o = o || {};
    try {
      const pls = await myPlaylists(false);
      const p = M.findPlaylist(pls, nameOrId);
      if (!p) {
        const names = pls.map((x) => x.name + '(' + x.count + ')').join('、');
        return { ok: false, msg: 'QQ 歌单里没有「' + M.cut(String(nameOrId == null ? '' : nameOrId), 30) + '」。现有的:' + (names || '(一个也没有)') };
      }
      const songs = await playlistSongs(p.id, false);
      const pg = M.pageSongs(songs, { q: o.q || '', limit: o.limit == null ? 30 : o.limit, shuffle: !!o.shuffle, offset: o.offset || 0 });
      return { ok: true, playlist: { id: p.id, name: p.name, count: p.count }, total: pg.total, songs: pg.songs.map(songView) };
    } catch (e) {
      if (e instanceof LoginError) return loginOut();
      return { ok: false, msg: 'QQ 歌单读取出错: ' + errMsg(e) };
    }
  }

  // 歌单里后面的歌先登记,播放端来取时再下;正在放的那首(currentMid)的下一首马上预下
  function addPending(songs, currentMid) {
    const list = (Array.isArray(songs) ? songs : []).map((x) => ({
      key: stripMid(x && (x.mid || x.id)),
      name: x && x.name,
      artists: x && x.artists,
      artist: x && x.artist,
      interval: x && x.interval,
    })).filter((x) => x.key);
    cache.addPending(list, stripMid(currentMid) || null);
  }

  return {
    enabled,
    status,
    fetchSong,
    fetchMid,
    playlists,
    playlistPage,
    addPending,
    urlFor: (mid) => (stripMid(mid) ? cache.urlFor(stripMid(mid)) : ''),
    listCached: () => cache.listCached(),
    serve: (req, res, name) => cache.serve(req, res, name),
  };
}

module.exports = { createQQ, LOGIN_MSG, isCdnHost };
