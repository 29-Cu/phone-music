'use strict';

// 网易云音源:通过你自己跑的、兼容 NeteaseCloudMusicApi 的 HTTP 服务搜歌、取播放链接、读你的歌单,
// 下到本机私有缓存里,给通话里的播放端放。只供自用,缓存的音频不能公开、不能转发。
//
// 本项目不含任何网易云接口的加密代码,只往你配置的 apiBase 发普通 HTTP 请求。
// 登录 cookie(MUSIC_U=...)放在 POST 请求体的 cookie 字段里(那类服务都认这个参数),
// 不放进网址,免得出现在访问日志里。其余参数放在网址上,另加 timestamp 绕开服务端的接口缓存。
// cookie.txt 每次用都按文件变化重读;内容不打日志、不回给调用方。
//
// 常见问题:从海外/机房 IP 访问,网易云会回 -460「网络环境存在风险」,这跟登录没关系。

const fs = require('fs');
const path = require('path');
const { createCache, readJsonFresh, writeJsonAtomic } = require('./cache.js');
const M = require('./match.js');

const LEVELS = ['exhigh', 'standard'];  // 先要 320k,拿不到完整的再要标准音质
const URL_TTL = 10 * 60 * 1000;
const LIST_TTL = 10 * 60 * 1000;
const PL_TTL = 6 * 3600 * 1000;
const ID_RE = /^\d{1,15}$/;
const ID_PREFIX = 'ne-';

const LOGIN_MSG = '网易云登录过期了(或者还没登录),会员歌曲和你的歌单现在读不了。' +
  '请在开着远程调试的那个浏览器里打开 music.163.com 重新登录,然后再跑一次 node tools/qq-login.js --site netease 就好。';
const BLOCK_MSG = '网易云拦了这台服务器的网络(-460「网络环境存在风险」),多半是因为服务器在海外或在机房。' +
  '这不是登录的问题,重新登录也没用;把网易云接口服务放到国内的家用网络上跑通常就好了,或者先换 QQ 音乐放。';
const NO_API_MSG = '没配置网易云接口服务(NETEASE_API),网易云这个音源没开。';

class LoginError extends Error {}
class BlockedError extends Error {}
class ApiDownError extends Error {}

function isCdnHost(host) {
  host = String(host || '').toLowerCase();
  return host.endsWith('.126.net') || host.endsWith('.163.com') || host.endsWith('.netease.com');
}

function stripId(v) {
  const s = String(v == null ? '' : v).trim().replace(/^ne-/, '');
  return ID_RE.test(s) ? s : '';
}

function errMsg(e) {
  return M.cut(String((e && e.message) || e), 120);
}

function extOf(x) {
  const t = String((x && (x.type || x.encodeType)) || '').toLowerCase();
  if (t === 'm4a' || t === 'mp4' || t === 'aac') return 'm4a';
  if (t === 'flac') return 'flac';
  return 'mp3';
}

function songOf(x) {
  return {
    id: x && x.id != null ? String(x.id) : '',
    name: (x && x.name) || '',
    artists: ((x && (x.ar || x.artists)) || []).map((a) => (a && a.name) || '').filter(Boolean),
    interval: Math.round((Number(x && (x.dt || x.duration)) || 0) / 1000),
  };
}

function createNetease(opts) {
  opts = opts || {};
  const apiBase = String(opts.apiBase || '').trim().replace(/\/+$/, '');
  const cookieFile = opts.cookieFile || '';
  const metaFile = opts.metaFile || (cookieFile ? path.join(path.dirname(cookieFile), 'meta.json') : '');
  const cacheDir = opts.cacheDir;
  const plDir = opts.playlistCacheDir || path.join(cacheDir, 'playlists');
  const doFetch = (...a) => (opts.fetch || globalThis.fetch)(...a);
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const ck = { sig: '', val: '' };
  const urls = new Map();
  const lastFail = { at: 0, why: '' };
  const plList = { at: 0, val: null };
  const who = { at: 0, uid: '' };
  const plInflight = new Map();

  // ── 登录 ──
  // 文件里可以是整串「MUSIC_U=...; __csrf=...」,也可以只放 MUSIC_U 的值
  function cookie() {
    let st;
    try { st = fs.statSync(cookieFile); } catch (_) { return ''; }
    const sig = st.mtimeMs + ':' + st.size + ':' + st.ino;
    if (sig !== ck.sig) {
      try {
        let v = fs.readFileSync(cookieFile, 'utf8').trim();
        if (v && !v.includes('=')) v = 'MUSIC_U=' + v;
        ck.val = v;
        ck.sig = sig;
      } catch (_) { return ''; }
    }
    return ck.val;
  }

  function hasKey(c) {
    return /(?:^|;\s*)MUSIC_U=[^;\s]/.test(c);
  }

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

  function outErr(r, fallback) {
    if (r && (r.why === 'expired' || r.why === 'nologin')) return { ok: false, login: true, msg: LOGIN_MSG };
    return { ok: false, msg: (r && r.msg) || fallback || '网易云这首拿不到。' };
  }

  function errOf(e, prefix) {
    if (e instanceof BlockedError) return { ok: false, why: 'blocked', msg: BLOCK_MSG };
    if (e instanceof LoginError) return fail('expired', LOGIN_MSG);
    if (e instanceof ApiDownError) {
      return { ok: false, why: 'error', msg: '连不上网易云接口服务,确认它在跑、NETEASE_API 写对了(' + errMsg(e) + ')。' };
    }
    return { ok: false, why: 'error', msg: (prefix || '网易云出错: ') + errMsg(e) };
  }

  function enabled() {
    return !!apiBase && !!cookie();
  }

  // ── 请求 ──
  async function call(pathname, params, timeoutMs) {
    if (!apiBase) throw new ApiDownError('没配置 NETEASE_API');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) qs.set(k, String(v));
    qs.set('timestamp', String(Date.now()));
    const c = cookie();
    const body = new URLSearchParams();
    if (c) body.set('cookie', c);
    let r;
    try {
      r = await doFetch(apiBase + pathname + '?' + qs.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs || 15000),
      });
    } catch (e) {
      throw new ApiDownError(errMsg(e));
    }
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch (_) {}
    if (d && typeof d === 'object' && Number(d.code) === -460) throw new BlockedError(BLOCK_MSG);
    if (!d || typeof d !== 'object') throw new Error('网易云接口服务回的不是 JSON(HTTP ' + r.status + ')');
    return d;
  }

  async function loginInfo(fresh) {
    const now = Date.now();
    if (!fresh && who.uid && now - who.at < LIST_TTL) return who;
    const d = await call('/login/status', {});
    const data = d.data && typeof d.data === 'object' ? d.data : d;
    const prof = data.profile || null;
    who.uid = prof && prof.userId ? String(prof.userId) : '';
    who.at = now;
    return who;
  }

  async function status() {
    if (!apiBase) return { enabled: false, logged_in: false, expires_at: 0, msg: NO_API_MSG };
    const c = cookie();
    const exp = expiresAt();
    if (!c) return { enabled: false, logged_in: false, expires_at: 0, msg: LOGIN_MSG };
    if (!hasKey(c)) return { enabled: true, logged_in: false, expires_at: exp, msg: LOGIN_MSG };
    if (exp && Date.now() / 1000 > exp) return { enabled: true, logged_in: false, expires_at: exp, msg: LOGIN_MSG };
    try {
      const u = await loginInfo(true);
      if (!u.uid) {
        fail('expired', LOGIN_MSG);
        return { enabled: true, logged_in: false, expires_at: exp, msg: LOGIN_MSG };
      }
      const h = exp ? Math.round((exp - Date.now() / 1000) / 360) / 10 : 0;
      return { enabled: true, logged_in: true, expires_at: exp, msg: '网易云已登录' + (exp ? ',登录大约 ' + h + ' 小时后到期' : '') + '。' };
    } catch (e) {
      return { enabled: true, logged_in: false, expires_at: exp, msg: errOf(e, '网易云登录状态查不到: ').msg };
    }
  }

  // 搜索出错要往上抛:-460 / 接口服务没开要原样告诉用户,不能当成「没搜到」
  async function search(query, n) {
    const d = await call('/cloudsearch', { keywords: query, type: 1, limit: n || 10 });
    if (Number(d.code) === 301) throw new LoginError(LOGIN_MSG);
    return (((d.result || {}).songs) || []).map(songOf).filter((x) => x.id);
  }

  // 按歌号取完整播放链接;没链接、只给试听片段(freeTrialInfo)都算放不了
  async function rawUrl(id) {
    const now = Date.now();
    const hit = urls.get(id);
    if (hit && now - hit.t < URL_TTL) return hit.res;
    let last = null;
    for (const level of LEVELS) {
      const d = await call('/song/url/v1', { id, level });
      if (Number(d.code) === 301) return fail('nologin', LOGIN_MSG);
      const list = Array.isArray(d.data) ? d.data : [];
      const x = list.find((i) => i && String(i.id) === String(id)) || list[0] || null;
      if (x && x.url && !x.freeTrialInfo && (x.code == null || Number(x.code) === 200)) {
        const res = { ok: true, url: String(x.url), br: Number(x.br) || 0, ext: extOf(x), id };
        urls.set(id, { t: now, res });
        if (lastFail.why) lastFail.why = '';
        return res;
      }
      last = x;
    }
    const why = !last ? '接口没回数据' : last.freeTrialInfo ? '只给试听片段' : !last.url ? '没有播放链接' : '返回码 ' + last.code;
    return fail('nourl', '网易云这首拿不到完整的播放链接(' + why + ',可能是会员歌曲、单曲付费或者下架了' +
      (hasKey(cookie()) ? '' : ';现在没登录,只能放免费的歌') + ')。');
  }

  async function urlForId(id) {
    try { return await rawUrl(id); } catch (e) { return errOf(e); }
  }

  async function detail(id) {
    const d = await call('/song/detail', { ids: id });
    const x = (d.songs || [])[0];
    if (!x || !x.name) return null;
    const s = songOf(x);
    return { name: s.name, artists: s.artists, interval: s.interval };
  }

  async function alts(name, artists, dur, exclude) {
    const q = (String(name || '') + ' ' + (artists[0] || '')).trim();
    const cands = await search(q, 10);
    return M.alternatives(name, artists, dur, cands.filter((c) => c.id !== exclude));
  }

  async function urlWithAlt(id, name, artists, dur) {
    const r = await urlForId(id);
    if (r.ok || r.why !== 'nourl') return r;
    try {
      if (name == null) {
        const d = (await detail(id)) || {};
        name = d.name || '';
        artists = d.artists || [];
        dur = d.interval || 0;
      }
      if (!name) return r;
      for (const c of await alts(name, artists || [], dur, id)) {
        const r2 = await urlForId(c.id);
        if (r2.ok) return Object.assign({}, r2, { alt: { id: c.id, name: c.name, artists: c.artists, interval: c.interval } });
      }
    } catch (_) {}
    return r;
  }

  async function resolveId(id, hint) {
    const hn = hint && hint.name ? String(hint.name) : '';
    const ha = hint ? M.splitArtists(hint.artists || hint.artist) : [];
    const hd = hint ? Number(hint.interval) || 0 : 0;
    const r = hn ? await urlWithAlt(id, hn, ha, hd) : await urlWithAlt(id);
    if (r.ok && r.alt) return Object.assign({}, r, { name: r.alt.name, artists: r.alt.artists, interval: r.alt.interval });
    if (r.ok) {
      if (hn) return Object.assign({}, r, { name: hn, artists: ha, interval: hd });
      try {
        const d = (await detail(id)) || {};
        return Object.assign({}, r, { name: d.name || '', artists: d.artists || [], interval: d.interval || 0 });
      } catch (_) {}
    }
    return r;
  }

  async function resolve(query) {
    try {
      const q = M.cut(String(query || '').trim(), 80);
      if (!q) return { ok: false, why: 'nomatch', msg: '没给歌名。' };
      const cands = (await search(q, 10)).filter((c) => !c.interval || c.interval >= 30);
      if (!cands.length) return { ok: false, why: 'nomatch', msg: '网易云上没搜到「' + q + '」。' };
      let c = cands[0];
      let r = null;
      for (const cc of cands.slice(0, 4)) {
        r = await rawUrl(cc.id);
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
      return errOf(e);
    }
  }

  const cache = createCache({
    dir: cacheDir,
    maxBytes: opts.maxCacheBytes || 2 * 1024 ** 3,
    urlPrefix: opts.urlPrefix || '/api/ne/',
    keyPattern: '[0-9]{1,15}',
    idPrefix: ID_PREFIX,
    label: 'netease',
    allowHost: isCdnHost,
    fetch: doFetch,
    log,
    resolveKey: async (id, hint) => {
      const r = await resolveId(id, hint);
      return r.ok ? r : outErr(r);
    },
  });

  async function fetchSong(query) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, msg: '要给歌名(最好带上歌手),比如「月亮代表我的心 邓丽君」。' };
    if (!apiBase) return { ok: false, msg: NO_API_MSG };
    cache.ensureDir();
    const hit = cache.findCached(q);
    if (hit) return cache.fetchKey(hit.key, null);
    const r = await resolve(q);
    if (!r.ok) return outErr(r, '网易云上没找到「' + M.cut(q, 40) + '」。');
    return cache.store(r.id, r, q, null);
  }

  // 按歌号拿一首;换了版(alt)也存在原歌号名下
  async function fetchId(id, o) {
    const k = stripId(id);
    if (!k) return { ok: false, msg: '歌号格式不对。' };
    if (!apiBase && !cache.entry(k)) return { ok: false, msg: NO_API_MSG };
    return cache.fetchKey(k, o && o.hint ? o.hint : null);
  }

  // ── 歌单(只读)── 「我喜欢」(specialType=5)排第一,然后自建,然后收藏的
  async function myPlaylists(fresh) {
    const now = Date.now();
    if (!fresh && plList.val && now - plList.at < LIST_TTL) return plList.val;
    const c = cookie();
    if (!c || !hasKey(c)) throw new LoginError(LOGIN_MSG);
    const u = await loginInfo(false);
    if (!u.uid) throw new LoginError(LOGIN_MSG);
    const d = await call('/user/playlist', { uid: u.uid, limit: 1000, offset: 0 });
    if (Number(d.code) === 301) throw new LoginError(LOGIN_MSG);
    if (d.code != null && Number(d.code) !== 200) throw new Error('网易云歌单接口回 code ' + d.code);
    const out = [];
    for (const x of d.playlist || []) {
      if (!x || x.id == null) continue;
      const creator = x.creator || {};
      const own = String(creator.userId != null ? creator.userId : x.userId) === u.uid;
      const liked = own && Number(x.specialType) === 5;
      const kind = liked ? 'liked' : (x.subscribed || !own) ? 'fav' : 'mine';
      const cnt = parseInt(x.trackCount, 10) || 0;
      if (kind !== 'fav' && !cnt) continue;
      out.push({ id: String(x.id), name: liked ? '我喜欢' : (x.name || ''), count: cnt, kind, owner: kind === 'fav' ? (creator.nickname || '') : '' });
    }
    const rank = { liked: 0, mine: 1, fav: 2 };
    out.sort((a, b) => rank[a.kind] - rank[b.kind]);
    plList.at = now;
    plList.val = out;
    return out;
  }

  // 整个歌单的歌,每页 1000 首、最多 1 万首,6 小时存盘缓存
  function playlistSongs(pid, count, fresh) {
    if (!ID_RE.test(String(pid))) return Promise.reject(new Error('歌单号不对'));
    const fp = path.join(plDir, String(pid) + '.json');
    if (!fresh) {
      const hit = readJsonFresh(fp, PL_TTL);
      if (Array.isArray(hit)) return Promise.resolve(hit);
    }
    if (plInflight.has(pid)) return plInflight.get(pid);
    const p = (async () => {
      const songs = [];
      let offset = 0;
      for (;;) {
        const d = await call('/playlist/track/all', { id: pid, limit: 1000, offset }, 60000);
        if (d.code != null && Number(d.code) !== 200) {
          if (!songs.length) {
            if (Number(d.code) === 301 || !hasKey(cookie())) throw new LoginError(LOGIN_MSG);
            throw new Error('网易云歌单接口回 code ' + d.code);
          }
          break;
        }
        const sl = d.songs || [];
        for (const x of sl) {
          const s = songOf(x);
          if (s.id) songs.push(s);
        }
        offset += 1000;
        if (sl.length < 1000 || (count && offset >= count) || offset >= 10000) break;
      }
      writeJsonAtomic(fp, songs);
      return songs;
    })().finally(() => plInflight.delete(pid));
    plInflight.set(pid, p);
    return p;
  }

  function songView(x) {
    return { id: ID_PREFIX + x.id, name: x.name, artist: x.artists.join(', '), interval: x.interval };
  }

  function listErr(e) {
    const r = errOf(e, '网易云歌单读取出错: ');
    return r.why === 'expired' ? { ok: false, login: true, msg: LOGIN_MSG } : { ok: false, msg: r.msg };
  }

  async function playlists() {
    if (!apiBase) return { ok: false, msg: NO_API_MSG };
    try {
      const pls = await myPlaylists(false);
      return { ok: true, playlists: pls.map((p) => Object.assign({}, p)) };
    } catch (e) {
      return listErr(e);
    }
  }

  async function playlistPage(nameOrId, o) {
    o = o || {};
    if (!apiBase) return { ok: false, msg: NO_API_MSG };
    try {
      const pls = await myPlaylists(false);
      const s = String(nameOrId == null ? '' : nameOrId).trim().replace(/^ne-/, '');
      const p = M.findPlaylist(pls, s);
      if (!p) {
        const names = pls.map((x) => x.name + '(' + x.count + ')').join('、');
        return { ok: false, msg: '网易云歌单里没有「' + M.cut(s, 30) + '」。现有的:' + (names || '(一个也没有)') };
      }
      const songs = await playlistSongs(p.id, p.count, false);
      const pg = M.pageSongs(songs, { q: o.q || '', limit: o.limit == null ? 30 : o.limit, shuffle: !!o.shuffle, offset: o.offset || 0 });
      return { ok: true, playlist: { id: p.id, name: p.name, count: p.count }, total: pg.total, songs: pg.songs.map(songView) };
    } catch (e) {
      return listErr(e);
    }
  }

  function addPending(songs, currentId) {
    const list = (Array.isArray(songs) ? songs : []).map((x) => ({
      key: stripId(x && x.id),
      name: x && x.name,
      artists: x && x.artists,
      artist: x && x.artist,
      interval: x && x.interval,
    })).filter((x) => x.key);
    cache.addPending(list, stripId(currentId) || null);
  }

  return {
    enabled,
    status,
    fetchSong,
    fetchId,
    playlists,
    playlistPage,
    addPending,
    urlFor: (id) => (stripId(id) ? cache.urlFor(stripId(id)) : ''),
    listCached: () => cache.listCached(),
    serve: (req, res, name) => cache.serve(req, res, name),
  };
}

module.exports = { createNetease, LOGIN_MSG, BLOCK_MSG, isCdnHost };
