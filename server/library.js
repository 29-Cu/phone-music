"use strict";

// 曲库:你和 AI 一起攒的音乐。
//
// 文件:<dataDir>/library/<随机id>.mp3|.m4a,索引:<dataDir>/library.json
//   { tracks:[{ id,title,url,added_by:'user'|'ai',added_at,source,license,duration,bytes,sha1 }] }
// 进库前用 ffprobe 验:必须有音轨、2 秒 ~ 3 小时。mp3 / aac·alac(m4a) 原样收;
// 别的(wav/flac/ogg/opus/带画面的 mp4…)用 ffmpeg 转成 mp3 192k(iPhone 一定放得出)。同一份内容(sha1)不重复存。
// AI 从网上收歌必须写授权(CC0 / 公版 / CC BY …);谁能删:你什么都能删,AI 只能删它自己放的。
// 写索引走进程内串行 + 临时文件改名,同一个进程里并发安全。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { execFile } = require("child_process");

const MAX_BYTES = 80 * 1024 * 1024;
const MIN_SEC = 2, MAX_SEC = 3 * 3600;
const TITLE_MAX = 80, LICENSE_MAX = 120, SOURCE_MAX = 300;
const URL_PREFIX = "/media/library/";
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|aif|aiff|weba|webm)$/i;

function bad(msg) { const e = new Error(msg); e.bad = true; return e; }
function cleanText(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function titleFromName(name) {
  const base = path.basename(String(name || "")).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_]+/g, " ");
  return cleanText(base, TITLE_MAX);
}
function rmq(f) { try { fs.unlinkSync(f); } catch (_) {} }

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ""); return reject(err); }
      resolve(String(stdout || ""));
    });
  });
}
async function probe(file) {
  let j;
  try {
    j = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name:stream_disposition=attached_pic", "-of", "json", file], 20000));
  } catch (e) { return null; }
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const audio = streams.filter((s) => s.codec_type === "audio");
  const video = streams.filter((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
  return {
    format: String((j.format && j.format.format_name) || ""),
    duration: Number((j.format && j.format.duration) || 0) || 0,
    acodec: audio.length ? String(audio[0].codec_name || "") : "",
    hasAudio: audio.length > 0,
    hasVideo: video.length > 0,
  };
}
function sha1Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    fs.createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

// 时长(秒):ffprobe 一次,按文件 + mtime 记住
const _dur = new Map();
function durationOf(file) {
  return new Promise((resolve) => {
    let key;
    try { key = file + ":" + fs.statSync(file).mtimeMs; } catch (e) { return resolve(0); }
    if (_dur.has(key)) return resolve(_dur.get(key));
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 8000 }, (err, stdout) => {
      const d = err ? 0 : Math.round(Number(String(stdout).trim()) || 0);
      _dur.set(key, d);
      resolve(d);
    });
  });
}

// 不去拿本机 / 内网的地址(防止 AI 被一条链接骗去扫你的内网)
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s.startsWith("::ffff:")) return privateIp(s.slice(7));
    return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80");
  }
  return true;
}
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw bad("只认 http/https 链接");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || /\.local$/i.test(host)) throw bad("不拿本机/内网的地址");
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else { try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw bad("这个网址找不到(" + host + ")"); } }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw bad("不拿本机/内网的地址");
}

function createLibrary(cfg) {
  const libDir = cfg.libraryDir;
  const libJson = cfg.libraryJson;
  const tmpDir = path.join(libDir, "_tmp");
  const importDirs = cfg.importDirs || [];

  function readLib() {
    try {
      const j = JSON.parse(fs.readFileSync(libJson, "utf8"));
      return { tracks: Array.isArray(j.tracks) ? j.tracks : [] };
    } catch (e) { return { tracks: [] }; }
  }
  function writeLib(lib) {
    fs.mkdirSync(path.dirname(libJson), { recursive: true });
    const tmp = libJson + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ tracks: lib.tracks }, null, 2));
    fs.renameSync(tmp, libJson);
  }
  let _chain = Promise.resolve();
  function serial(fn) {
    const p = _chain.then(fn, fn);
    _chain = p.catch(() => {});
    return p;
  }
  function fileOf(t) { return path.join(libDir, path.basename(String(t.url || ""))); }

  // 有文件的才算(文件被手动删了,条目自动不出现)
  function list() {
    return readLib().tracks.filter((t) => t && t.id && t.url && fs.existsSync(fileOf(t))).map((t) => Object.assign({}, t, { file: fileOf(t) }));
  }
  function find(q) {
    const s = String(q || "").trim();
    if (!s) return null;
    const all = list();
    const fold = (x) => String(x || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "");
    return all.find((t) => t.id === s || (t.id.startsWith(s) && s.length >= 6)) || all.find((t) => fold(t.title) === fold(s)) || null;
  }
  // /media/library/<名字> → 文件路径(只认库里有的)
  function fileForName(name) {
    if (!/^[a-f0-9]{12}\.(mp3|m4a)$/.test(String(name || ""))) return null;
    const t = list().find((x) => path.basename(x.url) === name);
    return t ? t.file : null;
  }

  function newTmp(ext) {
    fs.mkdirSync(tmpDir, { recursive: true });
    return path.join(tmpDir, Date.now() + "-" + crypto.randomBytes(4).toString("hex") + (ext || ".bin"));
  }

  // 把一个临时文件收进库。tmpFile 无论成败都会被处理掉(挪走或删掉)。meta: { title, added_by, source, license }
  async function ingest(tmpFile, meta) {
    meta = meta || {};
    try {
      const title = cleanText(meta.title, TITLE_MAX);
      if (!title) throw bad("要给这首起个名字");
      const st = fs.statSync(tmpFile);
      if (!st.size) throw bad("文件是空的");
      if (st.size > MAX_BYTES) throw bad("文件太大(最多 " + Math.round(MAX_BYTES / 1048576) + "MB)");
      const p = await probe(tmpFile);
      if (!p || !p.hasAudio) throw bad("这不是能放的音频文件");
      if (p.duration && p.duration < MIN_SEC) throw bad("太短了(不到 " + MIN_SEC + " 秒)");
      if (p.duration > MAX_SEC) throw bad("太长了(超过 3 小时)");
      const sha1 = await sha1Of(tmpFile);
      const dup = list().find((t) => t.sha1 === sha1);
      if (dup) { rmq(tmpFile); return { dup: true, track: dup }; }

      const id = crypto.randomBytes(6).toString("hex");
      fs.mkdirSync(libDir, { recursive: true });
      let ext, out;
      const isMp3 = /(^|,)mp3(,|$)/.test(p.format) && p.acodec === "mp3" && !p.hasVideo;
      const isM4a = /mp4|m4a|mov/.test(p.format) && (p.acodec === "aac" || p.acodec === "alac") && !p.hasVideo;
      if (isMp3 || isM4a) {
        ext = isMp3 ? ".mp3" : ".m4a";
        out = path.join(libDir, id + ext);
        fs.renameSync(tmpFile, out);
      } else {
        ext = ".mp3";
        out = path.join(libDir, id + ext);
        const part = out + ".part.mp3";
        try {
          await run("ffmpeg", ["-y", "-v", "error", "-i", tmpFile, "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", "192k", part], 300000);
          fs.renameSync(part, out);
        } catch (e) {
          rmq(part);
          throw bad("转成 mp3 没成功" + (e && e.stderr ? ":" + cleanText(e.stderr, 80) : ""));
        }
        rmq(tmpFile);
      }
      let duration = p.duration;
      if (!isMp3 && !isM4a) { const p2 = await probe(out); if (p2 && p2.duration) duration = p2.duration; }
      const entry = {
        id, title, url: URL_PREFIX + id + ext,
        added_by: meta.added_by === "ai" ? "ai" : "user",
        added_at: new Date().toISOString(),
        source: cleanText(meta.source, SOURCE_MAX),
        license: cleanText(meta.license, LICENSE_MAX),
        duration: Math.round(duration || 0),
        bytes: fs.statSync(out).size,
        sha1,
      };
      await serial(() => { const lib = readLib(); lib.tracks.push(entry); writeLib(lib); });
      return { dup: false, track: Object.assign({}, entry, { file: out }) };
    } catch (e) {
      rmq(tmpFile);
      throw e;
    }
  }

  async function download(urlStr, fetchImpl) {
    const doFetch = fetchImpl || fetch;
    let u;
    try { u = new URL(urlStr); } catch (e) { throw bad("链接格式不对"); }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    try {
      let res;
      for (let hop = 0; ; hop++) {
        if (!cfg.allowLocalFetch) await assertPublic(u);
        res = await doFetch(u.href, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (phone-music)" } });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          if (hop >= 5) throw bad("跳转太多次");
          u = new URL(res.headers.get("location"), u);
          continue;
        }
        break;
      }
      if (!res.ok) throw bad("下载失败(HTTP " + res.status + ")");
      const ctype = String(res.headers.get("content-type") || "").toLowerCase();
      if (/text\/html|application\/xhtml/.test(ctype)) throw bad("这个链接是网页,不是音频文件。要找能直接下载的那个(一般 .mp3 / .ogg / .flac 结尾)");
      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_BYTES) throw bad("文件太大(" + Math.round(len / 1048576) + "MB,最多 " + Math.round(MAX_BYTES / 1048576) + "MB)");
      const tmp = newTmp(path.extname(u.pathname).slice(0, 6) || ".bin");
      const out = fs.createWriteStream(tmp);
      let got = 0;
      try {
        for await (const chunk of res.body) {
          got += chunk.length;
          if (got > MAX_BYTES) throw bad("文件太大(最多 " + Math.round(MAX_BYTES / 1048576) + "MB)");
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        }
        await new Promise((resolve, reject) => { out.on("error", reject); out.end(resolve); });
      } catch (e) {
        out.destroy(); rmq(tmp);
        throw e;
      }
      return { tmp, finalUrl: u.href };
    } catch (e) {
      if (e && e.name === "AbortError") throw bad("下载超时(两分钟)");
      throw e;
    } finally { clearTimeout(timer); }
  }

  // 「导入目录」里的音频(比如 AI 浏览器的下载目录),新的在前。只认音频扩展名、不认符号链接
  function listDownloads(maxAgeMs) {
    const out = [], t = Date.now();
    for (const dir of importDirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const n of names) {
        if (!AUDIO_EXT.test(n)) continue;
        const fp = path.join(dir, n);
        let st;
        try { st = fs.lstatSync(fp); } catch (_) { continue; }
        if (!st.isFile()) continue;
        if (maxAgeMs && t - st.mtimeMs > maxAgeMs) continue;
        out.push({ name: n, path: fp, bytes: st.size, mtime: st.mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  function downloadName(s) {
    const x = String(s || "").trim();
    return /^download\s*[:：]/i.test(x) ? x.replace(/^download\s*[:：]\s*/i, "").trim() : null;
  }
  function copyDownload(name) {
    const base = path.basename(String(name || "").replace(/\\/g, "/"));
    if (!base || base !== String(name).trim() || base.startsWith(".")) throw bad("download: 后面只写文件名(不带路径)");
    if (!AUDIO_EXT.test(base)) throw bad("只收音频文件(.mp3 .m4a .ogg .flac .wav …)");
    if (!importDirs.length) throw bad("服务器没开导入目录(PHONE_MUSIC_IMPORT_DIRS),download: 用不了");
    const hit = listDownloads().find((d) => d.name === base);
    if (!hit) throw bad("导入目录里没找到「" + base + "」。下载完了吗?action=downloads 看看有哪些");
    if (hit.bytes > MAX_BYTES) throw bad("文件太大(最多 " + Math.round(MAX_BYTES / 1048576) + "MB)");
    const tmp = newTmp(path.extname(base).slice(0, 6) || ".bin");
    fs.copyFileSync(hit.path, tmp);
    return tmp;
  }

  // AI 的 add:url = http(s) 直链,或 download:文件名(导入目录里的)
  async function addFrom(src, meta, opts) {
    const s = String(src || "").trim();
    if (!s) throw bad("要给 url");
    const dl = downloadName(s);
    if (dl !== null) {
      const tmp = copyDownload(dl);
      return ingest(tmp, Object.assign({}, meta, { source: meta.source || "下载 · " + dl.slice(0, 100) }));
    }
    const d = await download(s, opts && opts.fetch);
    return ingest(d.tmp, Object.assign({}, meta, { source: meta.source || d.finalUrl }));
  }

  // 上传:把请求体存成临时文件;超长 → bad
  function receive(req, ext) {
    return new Promise((resolve, reject) => {
      let tmp;
      try { tmp = newTmp(ext); } catch (e) { return reject(e); }
      const out = fs.createWriteStream(tmp);
      let got = 0, over = false, done = false;
      const fail = (e) => { if (done) return; done = true; out.destroy(); rmq(tmp); reject(e); };
      req.on("data", (c) => {
        got += c.length;
        if (over) return;
        if (got > MAX_BYTES) { over = true; return; }
        if (!out.write(c)) { req.pause(); out.once("drain", () => req.resume()); }
      });
      req.on("aborted", () => fail(bad("传到一半断了")));
      req.on("error", (e) => fail(e));
      out.on("error", (e) => fail(e));
      req.on("end", () => {
        if (over) return fail(bad("文件太大(最多 " + Math.round(MAX_BYTES / 1048576) + "MB)"));
        out.end(() => { if (done) return; done = true; resolve(tmp); });
      });
    });
  }

  async function rename(id, title) {
    const t = cleanText(title, TITLE_MAX);
    if (!t) throw bad("名字不能空着");
    return serial(() => {
      const lib = readLib();
      const e = lib.tracks.find((x) => x.id === id);
      if (!e) throw bad("没有这一首");
      e.title = t;
      writeLib(lib);
      return Object.assign({}, e);
    });
  }

  // by:'user' 什么都能删;'ai' 只能删自己放的
  async function remove(id, by) {
    return serial(() => {
      const lib = readLib();
      const i = lib.tracks.findIndex((x) => x.id === id);
      if (i < 0) throw bad("没有这一首");
      const e = lib.tracks[i];
      if (by === "ai" && e.added_by !== "ai") throw bad("这首是" + (cfg.userWord || "对方") + "放进来的,你删不了;要删请" + (cfg.userWord || "对方") + "在曲库页删");
      lib.tracks.splice(i, 1);
      writeLib(lib);
      rmq(fileOf(e));
      return e;
    });
  }

  return { list, find, fileForName, ingest, addFrom, receive, rename, remove, listDownloads, downloadName, _test: { download } };
}

module.exports = { createLibrary, cleanText, titleFromName, probe, durationOf, privateIp, MAX_BYTES, URL_PREFIX };
