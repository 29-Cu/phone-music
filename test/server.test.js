"use strict";
// HTTP 服务器 + MCP 入口:真起一个服务器(临时数据目录,随机端口),用 ffmpeg 生成两段测试音频。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-srv-"));
let haveFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", path.join(dir, "a.mp3")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:duration=3", path.join(dir, "b.wav")]);
} catch (e) { haveFfmpeg = false; }

const { createApp } = require("../server/index.js");
const cfg = {
  root: path.resolve(__dirname, ".."), dataDir: dir, token: "tok-123", userWord: "她", corsOrigins: [], importDirs: [],
  libraryDir: path.join(dir, "library"), libraryJson: path.join(dir, "library.json"), playlistsJson: path.join(dir, "pl.json"),
  staleMs: 60000, sourcesOrder: ["qq", "netease"],
};
const app = createApp(cfg, { sources: {}, log: () => {} });
let base;
test.before(() => new Promise((r) => app.server.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + app.server.address().port; r(); })));
test.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const H = { Authorization: "Bearer tok-123" };
const get = (p, h) => fetch(base + p, { headers: Object.assign({}, H, h) });
const post = (p, body, raw) => fetch(base + p, { method: "POST", headers: Object.assign({}, H, raw ? {} : { "Content-Type": "application/json" }), body: raw ? body : JSON.stringify(body) });

test("口令:不带 / 带错 = 401;页面不要口令", async () => {
  assert.strictEqual((await fetch(base + "/api/tool")).status, 401);
  assert.strictEqual((await fetch(base + "/api/tool", { headers: { Authorization: "Bearer nope" } })).status, 401);
  assert.strictEqual((await fetch(base + "/api/tool?t=tok-123")).status, 200);
  assert.strictEqual((await fetch(base + "/")).status, 200);
  assert.strictEqual((await fetch(base + "/phone-music-player.js")).status, 200);
});

test("上传 → 曲库 → 打电话放 → 播放端拿到指令 → Range 取歌", { skip: !haveFfmpeg && "没有 ffmpeg" }, async () => {
  let r = await (await post("/api/library/upload?name=Sine%20A.mp3", fs.readFileSync(path.join(dir, "a.mp3")), true)).json();
  assert.ok(r.ok && !r.dup && r.track.url.endsWith(".mp3"));
  r = await (await post("/api/library/upload?name=b.wav", fs.readFileSync(path.join(dir, "b.wav")), true)).json();
  assert.ok(r.ok && r.track.url.endsWith(".mp3"), "wav 转成 mp3");
  r = await (await post("/api/library/upload?name=again.mp3", fs.readFileSync(path.join(dir, "a.mp3")), true)).json();
  assert.ok(r.dup, "同一份内容不重复存");
  const bad = await post("/api/library/upload?name=x.mp3", Buffer.from("not audio at all"), true);
  assert.strictEqual(bad.status, 400);

  const lib = await (await get("/api/library")).json();
  assert.strictEqual(lib.tracks.length, 2);

  assert.match((await (await post("/api/tool", { action: "play", track: "sine a" })).json()).text, /没在打电话/);
  const p0 = await (await get("/api/music/pending?call_id=test-call&ms=0:idle")).json();
  assert.strictEqual(p0.music, undefined);
  assert.match((await (await post("/api/tool", { action: "play", track: "sine a", seconds: 60 })).json()).text, /好了:«Sine A»/);
  const p1 = await (await get("/api/music/pending?call_id=test-call&ms=0:idle")).json();
  assert.strictEqual(p1.music.action, "play");
  const url = p1.music.list[0].url;
  const part = await get(url, { Range: "bytes=0-99" });
  assert.strictEqual(part.status, 206);
  assert.strictEqual((await part.arrayBuffer()).byteLength, 100);
  assert.match(part.headers.get("content-range"), /^bytes 0-99\/\d+$/);
  assert.strictEqual((await fetch(base + url)).status, 401, "取歌也要口令");
  assert.strictEqual((await get("/media/library/../library.json")).status, 404);

  await get("/api/music/pending?call_id=test-call&ms=1:playing");
  assert.match((await (await get("/api/music/fact")).json()).text, /还在放「Sine A」/);

  // 改名 / AI 删不了用户放的 / 用户能删
  const id = lib.tracks.find((t) => t.title === "Sine A").id;
  assert.strictEqual((await (await post("/api/library/" + id, { title: "正弦 A" })).json()).track.title, "正弦 A");
  assert.match((await (await post("/api/tool", { action: "remove", track: "正弦 A" })).json()).text, /你删不了/);
  assert.ok((await (await fetch(base + "/api/library/" + id, { method: "DELETE", headers: H })).json()).ok);
});

test("MCP(stdio):initialize / tools/list / tools/call 转给服务器", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "mcp.js")], { env: Object.assign({}, process.env, { PHONE_MUSIC_URL: base, PHONE_MUSIC_TOKEN: "tok-123" }) });
  const lines = [];
  const waitFor = (id) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("MCP 没回 " + id)), 5000);
    const check = () => { const m = lines.find((x) => x.id === id); if (m) { clearTimeout(t); resolve(m); } else setTimeout(check, 20); };
    check();
  });
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.strictEqual((await waitFor(1)).result.serverInfo.name, "phone-music");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tl = await waitFor(2);
    assert.strictEqual(tl.result.tools[0].name, "phone_music");
    assert.ok(tl.result.tools[0].inputSchema.properties.action);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "phone_music", arguments: { action: "list" } } });
    assert.match((await waitFor(3)).result.content[0].text, /曲库/);
    send({ jsonrpc: "2.0", id: 4, method: "nope" });
    assert.strictEqual((await waitFor(4)).error.code, -32601);
  } finally { child.kill(); }
});
