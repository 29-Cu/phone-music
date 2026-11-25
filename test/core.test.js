"use strict";
// 核心:指令通道、认歌、工具(用假音源)。跑:npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createChannel } = require("../server/channel.js");
const { resolve } = require("../server/catalog.js");
const { createTool } = require("../server/tool.js");
const { createPlaylists } = require("../server/playlists.js");
const { privateIp } = require("../server/library.js");

function clock(t0) { let t = t0 || 1e12; const f = () => t; f.add = (ms) => { t += ms; }; return f; }

test("通道:没人来问 = 没在打电话;来问过 = 接通;一分钟不来 = 不在了", () => {
  const now = clock();
  const ch = createChannel({ staleMs: 60000, now, userWord: "她" });
  assert.deepStrictEqual(ch.setMusic(null, { action: "play" }), { error: "nocall" });
  assert.strictEqual(ch.poll("bad id!"), null);
  ch.poll("call-1", "0:idle");
  const r = ch.setMusic(null, { action: "play", title: "雨", list: [{ title: "雨", url: "/a.mp3" }], seconds: 600 });
  assert.strictEqual(r.seq, 1);
  const got = ch.poll("call-1", "0:idle");
  assert.strictEqual(got.music.seq, 1);
  assert.strictEqual(got.music.action, "play");
  now.add(61000);
  const st = ch.setMusic(null, { action: "stop" });
  assert.strictEqual(st.error, "stale");
  assert.strictEqual(st.seen_s, 61);
});

test("通道:如实报「电话里放着什么」", () => {
  const now = clock();
  const ch = createChannel({ now, userWord: "她" });
  ch.poll("call-1");
  assert.match(ch.fact(), /没在放/);
  ch.setMusic(null, { action: "play", title: "雨", seconds: 600, list: [] });
  assert.match(ch.fact(), /还在放「雨」,大概还剩 10 分钟/);
  ch.poll("call-1", "1:her");
  assert.match(ch.fact(), /她那头停掉了/);
  ch.setMusic(null, { action: "play", title: "你的歌单「夜里」", seconds: 28800, list: [] });
  ch.poll("call-1", "2:playing");
  assert.match(ch.fact(), /还在放你的歌单「夜里」,大概还剩 8 小时/);
  ch.end("call-1");
  assert.match(ch.fact(), /没在打电话/);
});

test("认歌:曲名 / 不分大小写不管重音 / 关键词 / 整个曲库", () => {
  const tracks = [{ title: "Gymnopédie No.1" }, { title: "Gymnopédie No.3" }, { title: "Smooth Lovin" }, { title: "雨声" }];
  assert.strictEqual(resolve("gymnopedie 3", tracks).title, "Gymnopédie No.3");
  assert.strictEqual(resolve("SMOOTH lovin", tracks).title, "Smooth Lovin");
  assert.strictEqual(resolve("雨", tracks).title, "雨声");
  assert.strictEqual(resolve("曲库", tracks).tracks.length, 4);
  assert.strictEqual(resolve("不存在", tracks), null);
});

test("下载防内网:私有地址都不拿", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) assert.ok(privateIp(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1"]) assert.ok(!privateIp(ip), ip);
});

// ── 工具:假曲库 + 假音源 ──
function setup(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-core-"));
  const now = clock();
  const channel = createChannel({ now, userWord: "她" });
  const lib = [
    { id: "aaaaaaaaaaaa", title: "Rain", url: "/media/library/aaaaaaaaaaaa.mp3", file: "/nope", duration: 100, added_by: "user" },
    { id: "bbbbbbbbbbbb", title: "Night Piano", url: "/media/library/bbbbbbbbbbbb.mp3", file: "/nope", duration: 200, added_by: "ai" },
  ];
  const library = { list: () => lib.slice(), find: () => null, listDownloads: () => [] };
  const calls = [];
  const fakeSrc = (prefix, ok) => ({
    enabled: () => true,
    fetchSong: async (q) => { calls.push(prefix + ":song:" + q); return ok ? { ok: true, track: { mid: "001abcdefgh", title: "晴天 - 周杰伦", url: "/api/" + prefix + "/001abcdefgh.mp3", duration: 269 }, others: [] } : { ok: false, msg: "没找到" }; },
    fetchMid: async (id) => { calls.push(prefix + ":id:" + id); return { ok: true, track: { mid: id, title: "x - y", url: "/api/" + prefix + "/" + id + ".mp3", duration: 200 } }; },
    fetchId: async (id) => { calls.push(prefix + ":id:" + id); return { ok: true, track: { id, title: "x - y", url: "/api/" + prefix + "/" + id + ".mp3", duration: 200 } }; },
    playlists: async () => ({ ok: true, playlists: [{ id: "1", name: "我喜欢", count: 2, kind: "liked" }] }),
    playlistPage: async (name, o) => ({ ok: true, playlist: { id: "1", name: "我喜欢", count: 2 }, total: 2,
      songs: [{ id: "qq-001aaaaaaaa", mid: "001aaaaaaaa", name: "A", artist: "X, Y", interval: 100 }, { id: "qq-001bbbbbbbb", mid: "001bbbbbbbb", name: "B", artist: "Z", interval: 120 }].slice(0, o.limit) }),
    addPending: (list, cur) => calls.push(prefix + ":pending:" + list.map((x) => x.mid).join(",") + "@" + cur),
    urlFor: (mid) => "/api/" + prefix + "/" + mid + ".mp3",
    listCached: () => [],
  });
  const sources = opts.noSources ? {} : { qq: fakeSrc("qq", opts.qqOk !== false), netease: fakeSrc("ne", true) };
  const cfg = { userWord: "她", importDirs: [], sourcesOrder: ["qq", "netease"] };
  const tool = createTool({ cfg, channel, library, playlists: createPlaylists(path.join(dir, "pl.json")), sources });
  return { tool, channel, calls, now, dir };
}

test("工具:没在电话里就直说,不去音源那边找", async () => {
  const { tool, calls } = setup();
  assert.match(await tool.handle({ action: "play", track: "rain" }), /没在打电话/);
  assert.match(await tool.handle({ action: "song", track: "晴天" }), /没在打电话/);
  assert.strictEqual(calls.length, 0);
});

test("工具:放曲库 / 循环 / 停", async () => {
  const { tool, channel } = setup();
  channel.poll("call-1");
  assert.match(await tool.handle({ action: "play", track: "rain", loop: true }), /好了:«Rain»,循环放\(最多 8 小时\)/);
  assert.strictEqual(channel.status().music.seconds, 8 * 3600);
  assert.match(await tool.handle({ action: "play", track: "曲库" }), /2 首连着放/);
  assert.match(await tool.handle({ action: "play", track: "没有的" }), /曲库里没有/);
  channel.poll("call-1", "2:her");
  assert.match(await tool.handle({ action: "stop" }), /她那边已经自己停了/);
});

test("工具:song 按顺序问音源,QQ 没有就问网易云;回话带歌号", async () => {
  const { tool, channel, calls } = setup({ qqOk: false });
  channel.poll("call-1");
  const r = await tool.handle({ action: "song", track: "晴天 周杰伦" });
  assert.match(r, /网易云 «晴天 - 周杰伦»\(歌号 ne-/);
  assert.deepStrictEqual(calls, ["qq:song:晴天 周杰伦", "ne:song:晴天 周杰伦"]);
  assert.strictEqual(channel.status().music.list[0].url, "/api/ne/001abcdefgh.mp3");
});

test("工具:用户的歌单连着放:第一首当场下,后面登记成待下", async () => {
  const { tool, channel, calls } = setup();
  channel.poll("call-1");
  const r = await tool.handle({ action: "playlist", track: "我喜欢", count: 2 });
  assert.match(r, /QQ 音乐歌单「我喜欢」按顺序放 2 首/);
  assert.deepStrictEqual(calls, ["qq:id:001aaaaaaaa", "qq:pending:001bbbbbbbb@001aaaaaaaa"]);
  assert.deepStrictEqual(channel.status().music.list.map((x) => x.url), ["/api/qq/001aaaaaaaa.mp3", "/api/qq/001bbbbbbbb.mp3"]);
});

test("工具:AI 自己的歌单:加曲库的、加歌号、按「歌名 歌手」找了再加,然后放", async () => {
  const { tool, channel } = setup();
  assert.match(await tool.handle({ action: "playlist_add", playlist: "夜里", track: "night piano" }), /新建了歌单「夜里」/);
  assert.match(await tool.handle({ action: "playlist_add", playlist: "夜里", track: "qq-002cccccccc", title: "C" }), /现在 2 首/);
  assert.match(await tool.handle({ action: "playlist_add", playlist: "夜里", track: "晴天 周杰伦" }), /在QQ 音乐找到的/);
  assert.match(await tool.handle({ action: "playlist_add", playlist: "夜里", track: "night piano" }), /已经有/);
  assert.match(await tool.handle({ action: "my_playlist" }), /夜里 — 3 首/);
  channel.poll("call-1");
  const r = await tool.handle({ action: "my_playlist", track: "夜里" });
  assert.match(r, /你的歌单「夜里」按顺序放 3 首/);
  assert.deepStrictEqual(channel.status().music.list.map((x) => x.url), ["/media/library/bbbbbbbbbbbb.mp3", "/api/qq/002cccccccc.mp3", "/api/qq/001abcdefgh.mp3"]);
  assert.match(await tool.handle({ action: "playlist_remove", playlist: "夜里", track: "晴天" }), /还剩 2 首/);
  assert.match(await tool.handle({ action: "playlist_remove", playlist: "夜里" }), /删掉了整张歌单/);
});

test("工具:说明只写开了的东西", () => {
  const a = setup({ noSources: true }).tool;
  assert.ok(!/action=song/.test(a.description()));
  assert.ok(!a.actions().includes("song"));
  const b = setup().tool;
  assert.ok(/action=song/.test(b.description()));
  assert.ok(b.actions().includes("playlists"));
  assert.strictEqual(b.definition().name, "phone_music");
});
