'use strict';

// 音频私有缓存:QQ 音乐、网易云共用。每个音源自己一个目录、自己一套歌号格式。
//
// 为什么先下到本地再放:音乐平台给的播放链接有时效,而且从海外第一次拉一首歌,CDN 要
// 0.3–15 秒才开始吐数据;下到本地以后,电话那头随便拖进度(Range)都是秒回。
//
// 目录结构:
//   <dir>/index.json      歌号 → { name, artists, interval, ext, br, at }
//   <dir>/<歌号>.<ext>    音频文件(mp3 / m4a / flac)
// 目录权限 700、文件 600:这是你自己会员下的歌,只给你自己的播放端用,不能公开、不能转发。
// 超过上限(默认 2GB)按 mtime 从旧往新删;每放一次 touch 一下,所以删的是最久没放的。
//
// 放歌单:第一首当场下好,后面的先登记成「待下」(pending);播放端来取哪首再下哪首,
// 并且放到第 i 首时顺手把第 i+1 首下好,歌与歌之间不空等。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { norm, cut, splitArtists } = require('./match.js');

const EXTS = ['mp3', 'm4a', 'flac'];
const CONTENT_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac' };
const MAX_FILE = 80 * 1024 * 1024;     // 单首上限:正常歌曲远小于这个
const MIN_FILE = 50 * 1024;            // 小于这个多半是错误页或试听片段,不是整首
const PENDING_TTL = 12 * 3600 * 1000;  // 待下列表 12 小时后作废
const PART_TTL = 3600 * 1000;          // 下到一半(进程被杀)留下的临时文件,1 小时后清掉

function readJsonFresh(file, ttlMs) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < ttlMs) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return null;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function errText(e) {
  return cut(String((e && e.message) || e), 80);
}

/**
 * opts:
 *   dir          缓存目录
 *   maxBytes     总上限(字节)
 *   urlPrefix    urlFor() 返回的路径前缀,如 '/api/qq/'
 *   keyPattern   歌号的正则源码(不带 ^$),如 '[0-9A-Za-z]{8,24}'
 *   idPrefix     对外歌号前缀,如 'qq-'
 *   keyField     track 里额外放一份裸歌号的字段名(QQ 用 'mid';不需要就不传)
 *   label        日志前缀
 *   allowHost    (hostname) => boolean,只从这些音频服务器下载
 *   downloadHeaders  下载时额外带的请求头(如 Referer)
 *   resolveKey   async (key, hint) => { ok:true, url, ext, br, name, artists, interval, alt } | { ok:false, msg, login? }
 *   fetch, log
 */
function createCache(opts) {
  const dir = opts.dir;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 2 * 1024 ** 3;
  const urlPrefix = opts.urlPrefix;
  const keyRe = new RegExp('^(?:' + opts.keyPattern + ')$');
  const fileRe = new RegExp('^(' + opts.keyPattern + ')\\.(' + EXTS.join('|') + ')$');
  const idPrefix = opts.idPrefix || '';
  const keyField = opts.keyField || null;
  const label = opts.label || 'music';
  const allowHost = opts.allowHost;
  const downloadHeaders = opts.downloadHeaders || {};
  const resolveKey = opts.resolveKey;
  const doFetch = opts.fetch;
  const log = opts.log || (() => {});

  const indexFile = path.join(dir, 'index.json');
  const pending = new Map();   // key → { name, artists, interval, at }
  const inflight = new Map();  // key → Promise
  let queue = [];              // 最近一次排的歌单顺序

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function readIndex() {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (j && typeof j === 'object' && j.songs && typeof j.songs === 'object') return j;
    } catch (_) {}
    return { songs: {} };
  }

  function writeIndex(ix) {
    ensureDir();
    const tmp = indexFile + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(ix, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, indexFile);
  }

  function fileOf(key, ext) {
    return path.join(dir, key + '.' + ext);
  }

  function exists(fp) {
    try { return fs.statSync(fp).isFile(); } catch (_) { return false; }
  }

  function touch(fp) {
    const now = new Date();
    try { fs.utimesSync(fp, now, now); } catch (_) {}
  }

  // 磁盘上这首有没有(不看索引,任一格式都算)
  function have(key) {
    for (const e of EXTS) {
      const fp = fileOf(key, e);
      if (exists(fp)) return { ext: e, fp };
    }
    return null;
  }

  // 索引里有、文件也在
  function entry(key) {
    const s = readIndex().songs[key];
    return s && exists(fileOf(key, s.ext)) ? s : null;
  }

  function urlFor(key) {
    return urlPrefix + key + '.mp3';
  }

  function trackView(key, s) {
    const artists = s.artists || [];
    const t = { id: idPrefix + key };
    if (keyField) t[keyField] = key;
    t.title = s.name + (artists.length ? ' - ' + artists.join(', ') : '');
    t.url = urlFor(key);
    t.file = fileOf(key, s.ext);
    t.duration = s.interval || 0;
    return t;
  }

  function hitResult(key, s) {
    return { ok: true, track: trackView(key, s), cached: true, alt: false, others: [] };
  }

  // 按一句「歌名 歌手」在缓存里找:歌名对上,且(没写歌手,或写的歌手也对上)。多个命中取最近存的。
  function findCached(query) {
    const q = norm(query);
    if (!q) return null;
    const ix = readIndex();
    let best = null;
    for (const key of Object.keys(ix.songs)) {
      const s = ix.songs[key];
      if (!s || !exists(fileOf(key, s.ext))) continue;
      const t = norm(s.name);
      if (!t) continue;
      const arts = (s.artists || []).map(norm).filter(Boolean);
      const hit = q === t ||
        arts.some((a) => q === t + a || q === a + t) ||
        (q.includes(t) && arts.some((a) => q.includes(a)) && q.length <= t.length + arts.join('').length + 2);
      if (hit && (!best || (s.at || 0) > (best.s.at || 0))) best = { key, s };
    }
    return best;
  }

  async function download(url, dest) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !allowHost(u.hostname)) {
      throw new Error('链接不在允许的音频服务器上(' + cut(u.hostname, 60) + ')');
    }
    const res = await doFetch(u.href, {
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, downloadHeaders),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error('下载失败(HTTP ' + res.status + ')');
    if (!res.body) throw new Error('下载失败(没有内容)');
    const part = dest + '.part-' + crypto.randomBytes(3).toString('hex');
    const out = fs.createWriteStream(part, { mode: 0o600 });
    let got = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (got > MAX_FILE) throw new Error('文件太大');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
      if (got < MIN_FILE) throw new Error('下下来的文件太小(' + got + ' 字节),多半不是整首');
      fs.renameSync(part, dest);
    } catch (e) {
      out.destroy();
      try { fs.unlinkSync(part); } catch (_) {}
      throw e;
    }
    return got;
  }

  // 超上限按 mtime 从旧往新删;keepKey = 刚存的这首,不删。
  // 目录里不在索引里的音频文件(索引坏过、换过格式留下的)也算进总量、也会被删。
  function prune(keepKey) {
    const ix = readIndex();
    let changed = false;
    const files = [];
    const seen = new Set();
    let total = 0;
    for (const key of Object.keys(ix.songs)) {
      const fp = fileOf(key, ix.songs[key].ext);
      try {
        const st = fs.statSync(fp);
        files.push({ key, fp, size: st.size, mtime: st.mtimeMs, indexed: true });
        seen.add(fp);
        total += st.size;
      } catch (_) {
        delete ix.songs[key];
        changed = true;
      }
    }
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) {}
    const now = Date.now();
    for (const n of names) {
      const fp = path.join(dir, n);
      const m = fileRe.exec(n);
      if (m && !seen.has(fp)) {
        try {
          const st = fs.statSync(fp);
          if (st.isFile()) {
            files.push({ key: m[1], fp, size: st.size, mtime: st.mtimeMs, indexed: false });
            total += st.size;
          }
        } catch (_) {}
      } else if (/\.part-[0-9a-f]+$/.test(n)) {
        try { if (now - fs.statSync(fp).mtimeMs > PART_TTL) fs.unlinkSync(fp); } catch (_) {}
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const f of files) {
      if (total <= maxBytes) break;
      if (f.indexed && f.key === keepKey) continue;
      try { fs.unlinkSync(f.fp); } catch (_) {}
      if (f.indexed) { delete ix.songs[f.key]; changed = true; }
      total -= f.size;
      removed++;
    }
    if (changed) writeIndex(ix);
    return { total, removed };
  }

  // r = 音源解析好的结果:{ url, ext, br, name, artists, interval, alt, others }。
  // 下载(已有就不下)→ 记索引 → 超上限清理 → 返回对外的形状。
  async function store(key, r, q, hint) {
    if (!keyRe.test(String(key || ''))) return { ok: false, msg: '歌号格式不对。' };
    ensureDir();
    hint = hint || {};
    const prev = entry(key);
    let ext = EXTS.includes(r.ext) ? r.ext : 'mp3';
    let cached = false;
    if (prev) {
      cached = true;
      ext = prev.ext;
      touch(fileOf(key, ext));
    } else {
      try {
        await download(r.url, fileOf(key, ext));
      } catch (e) {
        return { ok: false, msg: '下载没成(' + errText(e) + ')。' };
      }
    }
    const ix = readIndex();
    const artists = (Array.isArray(r.artists) && r.artists.length ? r.artists : splitArtists(hint.artists || hint.artist))
      .slice(0, 10).map((a) => cut(a, 80));
    ix.songs[key] = {
      name: cut(r.name || hint.name || q, 80),
      artists,
      interval: Number(r.interval) || Number(hint.interval) || 0,
      ext,
      br: Number(r.br) || (prev && prev.br) || 0,
      at: Date.now(),
    };
    writeIndex(ix);
    prune(key);
    return {
      ok: true,
      track: trackView(key, ix.songs[key]),
      cached,
      alt: !!r.alt,
      others: Array.isArray(r.others) ? r.others.slice(0, 3) : [],
    };
  }

  // 按歌号拿一首:缓存有就直接用,没有就让音源解析再下载。同一首同时只下一次。
  function fetchKey(key, hint) {
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      ensureDir();
      const s0 = entry(key);
      if (s0) {
        touch(fileOf(key, s0.ext));
        return hitResult(key, s0);
      }
      let r;
      try {
        r = await resolveKey(key, hint || null);
      } catch (e) {
        return { ok: false, msg: '取歌出错(' + errText(e) + ')。' };
      }
      if (!r || !r.ok) return r || { ok: false, msg: '这首拿不到。' };
      return store(key, r, (hint && hint.name) || key, hint);
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function prefetch(key) {
    if (!key || !pending.has(key) || have(key)) return;
    fetchKey(key, pending.get(key)).then((r) => {
      if (!r || !r.ok) log('[' + label + '] 预下载没成 ' + key + ':' + ((r && r.msg) || '?'));
    }, () => {});
  }

  function prefetchAfter(key) {
    const i = queue.indexOf(key);
    if (i >= 0) prefetch(queue[i + 1]);
  }

  // songs = [{ key, name, artists|artist, interval }];currentKey = 正在放的那首(它的下一首会马上预下)
  function addPending(songs, currentKey) {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > PENDING_TTL) pending.delete(k);
    const list = (songs || []).filter((x) => x && keyRe.test(String(x.key || '')));
    for (const x of list) {
      pending.set(x.key, {
        name: cut(x.name, 80),
        artists: splitArtists(x.artists || x.artist),
        interval: Number(x.interval) || 0,
        at: now,
      });
    }
    const cur = currentKey && keyRe.test(String(currentKey)) ? currentKey : null;
    queue = (cur ? [cur] : []).concat(list.map((x) => x.key));
    if (cur) prefetchAfter(cur);
    else if (queue.length) prefetch(queue[0]);
  }

  function listCached() {
    const ix = readIndex();
    return Object.keys(ix.songs)
      .filter((key) => exists(fileOf(key, ix.songs[key].ext)))
      .sort((a, b) => (ix.songs[b].at || 0) - (ix.songs[a].at || 0))
      .map((key) => {
        const t = trackView(key, ix.songs[key]);
        const o = { id: t.id };
        if (keyField) o[keyField] = key;
        o.title = t.title;
        o.duration = t.duration;
        return o;
      });
  }

  function endWith(res, status, headers) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, Object.assign({ 'Cache-Control': 'private, no-store' }, headers || {}));
    res.end();
  }

  // 发文件,支持单段 Range(bytes=a-b / a- / -n);多段或写错的 Range 当没写,整首发。
  function sendFile(req, res, h) {
    if (res.headersSent || res.destroyed) return;
    let size;
    try { size = fs.statSync(h.fp).size; } catch (_) { return endWith(res, 404); }
    const headers = {
      'Content-Type': CONTENT_TYPES[h.ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers && req.headers.range;
    if (typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          const n = parseInt(m[2], 10);
          start = n > 0 ? Math.max(0, size - n) : size;
        } else {
          start = parseInt(m[1], 10);
          if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
        }
        if (start >= size || start > end) {
          return endWith(res, 416, { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes' });
        }
        status = 206;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      }
    }
    headers['Content-Length'] = size > 0 ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(h.fp, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // name = 路径最后一段,如 '<歌号>.mp3'。只认「歌号.扩展名」这一种写法,别的一律 404。
  async function serve(req, res, name) {
    const m = fileRe.exec(typeof name === 'string' ? name : '');
    if (!m) return endWith(res, 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') return endWith(res, 405, { Allow: 'GET, HEAD' });
    const key = m[1];
    const h0 = have(key);
    if (h0) {
      touch(h0.fp);
      prefetchAfter(key);
      return sendFile(req, res, h0);
    }
    const pend = pending.get(key);
    if (!pend) return endWith(res, 404);   // 只下排进歌单的那几首
    let r;
    try {
      r = await fetchKey(key, pend);
    } catch (e) {
      r = { ok: false, msg: errText(e), error: true };
    }
    const h1 = have(key);
    if (r && r.ok && h1) {
      prefetchAfter(key);
      return sendFile(req, res, h1);
    }
    log('[' + label + '] 歌单里这首没下成 ' + key + ':' + ((r && r.msg) || '?'));
    return endWith(res, r && r.login ? 503 : r && r.error ? 500 : 404);
  }

  return { ensureDir, isKey: (k) => keyRe.test(String(k || '')), findCached, entry, hitResult, store, fetchKey, addPending, prefetchAfter, urlFor, listCached, serve, prune, readIndex };
}

module.exports = { createCache, readJsonFresh, writeJsonAtomic, EXTS, CONTENT_TYPES, MIN_FILE };
