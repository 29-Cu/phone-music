#!/usr/bin/env node
"use strict";

// phone-music 服务器:一个进程,零依赖(只要 Node ≥18 和 ffmpeg/ffprobe)。
//
// 播放端(手机网页 / App)用的:
//   GET  /api/music/pending?call_id=&ms=seq:state   每 2.5 秒问一次:心跳 + 回报状态 + 拿最新指令
//   POST /api/music/end?call_id=                    挂断
//   GET  /media/library/<id>.mp3                    曲库里的歌(支持 Range)
//   GET  /api/qq/<mid>.mp3、/api/ne/<id>.mp3        音源缓存里的歌(放到才下,支持 Range)
// AI 用的:
//   GET  /api/tool                                  工具定义(name / description / input_schema,可直接给 function calling)
//   POST /api/tool  {action, track, ...}            调工具,回 {text}
//   GET  /api/music/fact?call_id=                   一句「电话里现在放着什么」(适合每一轮塞进 AI 的上下文)
// 曲库页用的:
//   GET  /api/library        POST /api/library/upload?name=&title=(body = 文件)
//   POST /api/library/<id> {title}                  DELETE /api/library/<id>
// 页面:/ = 试玩 + 曲库页(web/index.html),/phone-music-player.js = 播放端模块
//
// 认证:每个 /api 和 /media 请求都要带口令:Authorization: Bearer <token>,或 ?t=<token>(给 <audio> 用),或 cookie pm_t。

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { load } = require("./config.js");
const { createChannel } = require("./channel.js");
const { createLibrary, cleanText, titleFromName, MAX_BYTES } = require("./library.js");
const { createPlaylists } = require("./playlists.js");
const { createTool } = require("./tool.js");

function tryRequire(p) {
  try { return require(p); } catch (e) { if (e.code === "MODULE_NOT_FOUND" && String(e.message).includes(p.replace(/^\.\//, ""))) return null; throw e; }
}

function createApp(cfg, opts) {
  opts = opts || {};
  const log = opts.log || ((m) => console.log("[phone-music] " + m));
  const channel = createChannel({ staleMs: cfg.staleMs, userWord: cfg.userWord });
  const library = createLibrary(cfg);
  const playlists = createPlaylists(cfg.playlistsJson);

  // 音源(可选):QQ 音乐 / 网易云。没配置就不出现在工具说明里
  const sources = opts.sources || {};
  if (!opts.sources) {
    const qqMod = tryRequire("./sources/qq.js");
    if (qqMod) {   // 一直建着;有没有登录(cookie 文件在不在)每次现看,登录以后不用重启
      sources.qq = qqMod.createQQ(Object.assign({ urlPrefix: "/api/qq/", log }, cfg.qq));
    }
    const neMod = tryRequire("./sources/netease.js");
    if (neMod && cfg.netease.apiBase) {
      sources.netease = neMod.createNetease(Object.assign({ urlPrefix: "/api/ne/", log }, cfg.netease));
    }
  }
  const tool = createTool({ cfg, channel, library, playlists, sources });

  const WEB = path.join(cfg.root, "web");
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".m4a": "audio/mp4" };

  function safeEq(a, b) {
    const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }
  function authed(req, url) {
    const h = String(req.headers.authorization || "");
    if (h.startsWith("Bearer ") && safeEq(h.slice(7).trim(), cfg.token)) return true;
    if (url.searchParams.get("t") && safeEq(url.searchParams.get("t"), cfg.token)) return true;
    const ck = /(?:^|;\s*)pm_t=([^;]+)/.exec(String(req.headers.cookie || ""));
    return !!(ck && safeEq(decodeURIComponent(ck[1]), cfg.token));
  }
  function cors(req, res) {
    const o = req.headers.origin;
    if (!o || !cfg.corsOrigins.length) return;
    if (cfg.corsOrigins.includes("*") || cfg.corsOrigins.includes(o)) {
      res.setHeader("Access-Control-Allow-Origin", cfg.corsOrigins.includes("*") ? "*" : o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    }
  }
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }
  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("请求太大"), { bad: true })); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("不是 JSON"), { bad: true })); } });
      req.on("error", reject);
    });
  }
  // 发文件,支持 Range(iPhone 放音频一定会先要一小段)
  function sendFile(req, res, file, type) {
    let st;
    try { st = fs.statSync(file); } catch (e) { return json(res, 404, { error: "没有这个文件" }); }
    const size = st.size;
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { "Content-Range": "bytes */" + size }); return res.end(); }
      res.writeHead(206, Object.assign(headers, { "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": end - start + 1 }));
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, Object.assign(headers, { "Content-Length": size }));
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }
  function view(t) {
    return { id: t.id, title: t.title, url: t.url, added_by: t.added_by, added_at: t.added_at, source: t.source || "", license: t.license || "", duration: t.duration || 0, bytes: t.bytes || 0 };
  }
  function fail(res, e) {
    if (e && e.bad) return json(res, 400, { error: e.message });
    log("出错: " + (e && e.stack ? e.stack : e));
    return json(res, 500, { error: "出错了: " + String((e && e.message) || e).slice(0, 120) });
  }

  let uploading = 0;
  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    // 静态页面(不要口令;页面自己会问口令)
    if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/phone-music-player.js")) {
      const f = path.join(WEB, p === "/" ? "index.html" : p.slice(1));
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)], "Cache-Control": "no-cache" });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === "/healthz") return json(res, 200, { ok: true });

    if (!p.startsWith("/api/") && !p.startsWith("/media/")) return json(res, 404, { error: "没有这个地址" });
    if (!authed(req, url)) return json(res, 401, { error: "口令不对" });

    // ── 播放端 ──
    if (p === "/api/music/pending" && req.method === "GET") {
      const out = channel.poll(url.searchParams.get("call_id"), url.searchParams.get("ms"));
      if (!out) return json(res, 400, { error: "call_id 不对(4~80 个字母数字)" });
      return json(res, 200, out);
    }
    if (p === "/api/music/end" && req.method === "POST") return json(res, 200, { ok: channel.end(url.searchParams.get("call_id")) });
    if (p === "/api/music/fact" && req.method === "GET") return json(res, 200, { text: channel.fact(url.searchParams.get("call_id")) });

    let m;
    if ((m = /^\/media\/library\/([^/]+)$/.exec(p)) && (req.method === "GET" || req.method === "HEAD")) {
      const f = library.fileForName(m[1]);
      if (!f) return json(res, 404, { error: "曲库里没有这首" });
      return sendFile(req, res, f, MIME[path.extname(f)] || "application/octet-stream");
    }
    if ((m = /^\/api\/(qq|ne)\/([^/]+)$/.exec(p)) && (req.method === "GET" || req.method === "HEAD")) {
      const s = sources[m[1] === "qq" ? "qq" : "netease"];
      if (!s) return json(res, 404, { error: "这个音源没开" });
      try { return await s.serve(req, res, m[2]); } catch (e) { return fail(res, e); }
    }

    // ── AI ──
    if (p === "/api/tool" && req.method === "GET") return json(res, 200, tool.definition());
    if (p === "/api/tool" && req.method === "POST") {
      try {
        const input = await readJson(req, 32 * 1024);
        const text = await tool.handle(input, { callId: url.searchParams.get("call_id") || input.call_id || null });
        log("工具 " + (input.action || "") + (input.track ? " «" + String(input.track).slice(0, 40) + "»" : "") + " → " + text.slice(0, 60).replace(/\n/g, " "));
        return json(res, 200, { text });
      } catch (e) { return fail(res, e); }
    }
    if (p === "/api/sources" && req.method === "GET") {
      const out = {};
      for (const [k, s] of Object.entries(sources)) { try { out[k] = await s.status(); } catch (e) { out[k] = { error: String(e.message || e) }; } }
      return json(res, 200, out);
    }

    // ── 曲库页 ──
    if (p === "/api/library" && req.method === "GET") return json(res, 200, { tracks: library.list().map(view), max_mb: Math.round(MAX_BYTES / 1048576), user_word: cfg.userWord });
    if (p === "/api/library/upload" && req.method === "POST") {
      const name = String(url.searchParams.get("name") || "").slice(0, 200);
      const title = cleanText(url.searchParams.get("title"), 80) || titleFromName(name);
      const len = Number(req.headers["content-length"] || 0);
      if (len > MAX_BYTES) { req.resume(); return json(res, 413, { error: "文件太大(最多 " + Math.round(MAX_BYTES / 1048576) + "MB)" }); }
      if (uploading >= 2) { req.resume(); return json(res, 429, { error: "上一首还在收,等一下" }); }
      uploading++;
      try {
        const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || [".bin"])[0];
        const tmp = await library.receive(req, ext);
        const r = await library.ingest(tmp, { title: title || "没起名的", added_by: "user", source: "上传" + (name ? "(" + cleanText(name, 120) + ")" : "") });
        log("收了 «" + r.track.title + "»" + (r.dup ? "(重复,没存)" : ""));
        return json(res, 200, { ok: true, dup: !!r.dup, track: view(r.track) });
      } catch (e) { return fail(res, e); } finally { uploading--; }
    }
    if ((m = /^\/api\/library\/([a-f0-9]{12})$/.exec(p))) {
      try {
        if (req.method === "POST") { const b = await readJson(req, 16 * 1024); return json(res, 200, { ok: true, track: view(await library.rename(m[1], b.title)) }); }
        if (req.method === "DELETE") { await library.remove(m[1], "user"); return json(res, 200, { ok: true }); }
      } catch (e) { return fail(res, e); }
    }
    return json(res, 404, { error: "没有这个地址" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { fail(res, e); } catch (_) {} });
  });
  return { server, channel, library, playlists, tool, sources };
}

if (require.main === module) {
  const cfg = load();
  const app = createApp(cfg);
  app.server.listen(cfg.port, cfg.host, () => {
    console.log("phone-music 在 http://" + cfg.host + ":" + cfg.port + " 上跑起来了");
    console.log("  音源:" + (Object.keys(app.sources).join(" / ") || "没开(只放曲库)"));
    if (cfg.tokenCreated) console.log("  第一次启动,生成了访问口令,存在 " + path.join(cfg.dataDir, "token.txt") + "(页面和 MCP 都要用)");
  });
}

module.exports = { createApp };
