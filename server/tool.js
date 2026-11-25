"use strict";

// phone_music:给 AI 的那个工具。AI 调它 → 这里查曲库 / 音源、下好歌 → 把指令交给 channel → 手机几秒内开始放。
//
// 做成「工具」而不是「回复里的标记」:标记要等 AI 这一轮说完才执行,没法当场告诉它「现在没在打电话」;
// 工具当场回话,AI 知道放没放成、放的是哪一版、要放多久。
// 回给 AI 的话全是中文短句;怎么称呼用户由 PHONE_MUSIC_USER 决定(默认 TA)。

const { resolve: resolveTrack, mmss } = require("./catalog.js");
const { durationOf } = require("./library.js");

const MAX_SECONDS = 3600;
const LOOP_MAX = 8 * 3600;
const LIST_MAX = 30;

const SRC = {
  qq: { prefix: "qq-", label: "QQ 音乐", byId: (s, id, hint) => s.fetchMid(id, { hint }) },
  netease: { prefix: "ne-", label: "网易云", byId: (s, id, hint) => (s.fetchId || s.fetchMid).call(s, id, { hint }) },
};
const ID_RE = /^(qq-[0-9A-Za-z]{8,24}|ne-\d{1,15})$/;
function srcOfId(id) { return /^qq-/.test(id) ? "qq" : /^ne-/.test(id) ? "netease" : null; }
function bareId(id) { return String(id || "").replace(/^(qq|ne)-/, ""); }

function clampVolume(x) {
  const n = Number(x);
  return isFinite(n) && n > 0 ? Math.max(0.1, Math.min(1, n)) : 0.6;
}
function secondsOf(input) {
  if (input.loop) return Math.max(60, Math.min(LOOP_MAX, Math.round(Number(input.seconds) || LOOP_MAX)));
  const n = Math.round(Number(input.seconds) || 0);
  return n > 0 ? Math.min(MAX_SECONDS, n) : 0;
}
function howLongText(seconds, total, loop) {
  if (loop) return "循环放" + (seconds >= LOOP_MAX ? "(最多 " + (LOOP_MAX / 3600) + " 小时)" : " " + mmss(seconds)) + ",要停用 action=stop";
  return seconds ? "放 " + mmss(seconds) + " 后停" + (total && seconds > total ? "(比曲子长,会接着从头放)" : "") : "放完就停(" + mmss(total) + ")";
}
function shuffled(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function hintOf(x) { return { name: x.name, artist: String(x.artist || "").replace(/, /g, "/"), interval: x.interval || 0 }; }

function createTool({ cfg, channel, library, playlists, sources }) {
  const U = cfg.userWord || "TA";
  sources = sources || {};
  const order = () => (cfg.sourcesOrder || ["qq", "netease"]).filter((n) => SRC[n] && sources[n] && sources[n].enabled());
  const srcLabel = (n) => SRC[n].label;
  const refOf = (n, t) => SRC[n].prefix + bareId(t.id || t.mid);

  function fmtFail(r) {
    if (r && r.error === "nocall") return "现在没在打电话,什么都没做。";
    if (r && r.error === "stale") return "电话还连着,但" + U + "那边的播放端 " + r.seen_s + " 秒没动静了(多半锁屏或切走了),放不出去,什么都没做。";
    return null;
  }
  function send(ctx, cmd) {
    const r = channel.setMusic(ctx.callId, cmd);
    return fmtFail(r);
  }

  async function catalogText() {
    const tracks = library.list();
    if (!tracks.length) return "(曲库是空的。" + U + "可以在曲库页传歌,你也可以用 action=add 往里放版权允许的音乐。)";
    const lines = ["曲库(共 " + tracks.length + " 首;track 写曲名放一首,写「曲库」整个连着放):"];
    for (const t of tracks.slice(0, 80)) lines.push("  · " + t.title + " " + mmss(t.duration || await durationOf(t.file)) + (t.added_by === "ai" ? "(你放的)" : "(" + U + "放的)"));
    if (tracks.length > 80) lines.push("  …还有 " + (tracks.length - 80) + " 首");
    return lines.join("\n");
  }

  // ── 放曲库里的 ──
  async function play(input, ctx) {
    const track = String(input.track || "").trim();
    if (!track) return "要放哪首?track 写曲名;不知道有什么先用 action=list。";
    const hit = resolveTrack(track, library.list());
    if (!hit) return "曲库里没有「" + track.slice(0, 40) + "」。" + (order().length ? "流行歌用 action=song(track 写「歌名 歌手」)。" : "") + "\n" + await catalogText();
    const seconds = secondsOf(input), volume = clampVolume(input.volume);
    let total = 0;
    for (const t of hit.tracks) total += t.duration || await durationOf(t.file);
    const fail = send(ctx, { action: "play", title: hit.title, seconds, volume, total, list: hit.tracks.map((t) => ({ title: t.title, url: t.url })) });
    if (fail) return fail;
    return "好了:«" + hit.title + "»" + (hit.tracks.length > 1 ? "(" + hit.tracks.length + " 首连着放)" : "") + "," + howLongText(seconds, total, !!input.loop) +
      "。" + U + "手机几秒内开始放。要停用 action=stop。";
  }

  // 在音源里找一首并下好:按 id 直接找,或者按「歌名 歌手」依次问各个音源
  async function fetchFromSources(track, input) {
    const isId = ID_RE.test(track);
    let names = order();
    if (input.source) names = names.filter((n) => n === input.source || (input.source === "ne" && n === "netease"));
    if (isId) names = names.filter((n) => n === srcOfId(track));
    if (!names.length) {
      if (isId) return { ok: false, msg: srcLabel(srcOfId(track)) + "没开(服务器没配置),放不了 " + track + "。" };
      return { ok: false, msg: "服务器没配置任何音源(QQ 音乐 / 网易云),只能放曲库里的。" };
    }
    const msgs = [];
    for (const n of names) {
      const s = sources[n];
      let got;
      try {
        got = isId ? await SRC[n].byId(s, bareId(track), input.hint) : await s.fetchSong(track);
      } catch (e) { got = { ok: false, msg: String(e && e.message || e) }; }
      if (got && got.ok) return Object.assign({ src: n }, got);
      msgs.push(srcLabel(n) + ":" + (got && got.msg || "没找到"));
    }
    return { ok: false, msg: "没找到能放的「" + track.slice(0, 40) + "」——\n" + msgs.join("\n") };
  }

  // ── 放音源里的一首 ──
  async function song(input, ctx) {
    const track = String(input.track || "").trim();
    if (!track) return "action=song 要写 track:「歌名 歌手」(比如 月亮代表我的心 邓丽君),或者 qq-… / ne-… 歌号。";
    const fail0 = fmtFail(channel.status(ctx.callId));
    if (fail0) return fail0;   // 不在电话里就不去音源那边找了
    const got = await fetchFromSources(track, input);
    if (!got.ok) return got.msg;
    const t = got.track;
    const seconds = secondsOf(input), volume = clampVolume(input.volume);
    const total = t.duration || await durationOf(t.file);
    const fail = send(ctx, { action: "play", title: t.title, seconds, volume, total, list: [{ title: t.title, url: t.url }] });
    if (fail) return fail;
    const others = (got.others || []).length ? "。不是想要的那版的话,还有:" + got.others.map((o) => o.name + " - " + o.artist + " " + mmss(o.interval)).join(" / ") + "(track 写得更具体再点一次)" : "";
    return "好了:" + srcLabel(got.src) + " «" + t.title + "»(歌号 " + refOf(got.src, t) + ")" + (got.cached ? "(缓存里就有)" : "") +
      (got.alt ? "(原来那一版放不了,自动换了同一首的另一版)" : "") + "," + howLongText(seconds, total, !!input.loop) +
      "。" + U + "手机几秒内开始放。要停用 action=stop" + others + "。";
  }

  // 用户在音源里的歌单:按名字依次问各个音源
  async function findUserPlaylist(name, opts, input) {
    let names = order();
    if (input.source) names = names.filter((n) => n === input.source || (input.source === "ne" && n === "netease"));
    if (!names.length) return { ok: false, msg: "服务器没配置任何音源(QQ 音乐 / 网易云),没有" + U + "的歌单可看。" };
    const msgs = [];
    for (const n of names) {
      let r;
      try { r = await sources[n].playlistPage(name, opts); } catch (e) { r = { ok: false, msg: String(e && e.message || e) }; }
      if (r && r.ok) return Object.assign({ src: n }, r);
      if (r && r.login) return r;
      msgs.push(srcLabel(n) + ":" + (r && r.msg || "没找到"));
    }
    return { ok: false, msg: msgs.join("\n") };
  }

  async function userPlaylists(input) {
    const name = String(input.track || "").trim();
    if (!name) {
      let names = order();
      if (input.source) names = names.filter((n) => n === input.source || (input.source === "ne" && n === "netease"));
      if (!names.length) return "服务器没配置任何音源(QQ 音乐 / 网易云),没有" + U + "的歌单可看。";
      const kinds = { liked: U + "的红心", mine: U + "建的", fav: U + "收藏的" };
      const out = [];
      for (const n of names) {
        let r;
        try { r = await sources[n].playlists(); } catch (e) { r = { ok: false, msg: String(e && e.message || e) }; }
        if (!r || !r.ok) { out.push(srcLabel(n) + ":" + (r && r.msg || "读不到")); continue; }
        out.push(srcLabel(n) + "(只读):\n" + r.playlists.map((p) => "· " + p.name + " — " + p.count + " 首(" + (kinds[p.kind] || "") + (p.owner ? " · " + p.owner : "") + ")").join("\n"));
      }
      return U + "的歌单:\n" + out.join("\n") + "\n看里面的歌:action=playlists 配 track=歌单名;连着放:action=playlist。";
    }
    const r = await findUserPlaylist(name, { limit: 30, q: String(input.search || "").trim(), shuffle: !!input.shuffle }, input);
    if (!r.ok) return r.msg;
    return srcLabel(r.src) + "「" + r.playlist.name + "」" + (input.search ? "里含「" + String(input.search).slice(0, 20) + "」的" : "") + "共 " + r.total + " 首" +
      (input.shuffle ? ",随机抽的" : ",前 " + r.songs.length + " 首") + ":\n" +
      r.songs.map((x) => x.id + "  " + x.name + " - " + x.artist + " " + mmss(x.interval)).join("\n") +
      "\n放其中一首:action=song,track 写那首的歌号。";
  }

  // 把用户的一个歌单放进电话:第一首当场下好,后面的放到再下(播放端放第 i 首时,服务器提前下第 i+1 首)
  async function userPlaylistPlay(input, ctx) {
    const name = String(input.track || "").trim();
    if (!name) return "action=playlist 要写 track=歌单名(先用 action=playlists 看" + U + "有哪些)。";
    const fail0 = fmtFail(channel.status(ctx.callId));
    if (fail0) return fail0;
    const count = Math.max(1, Math.min(LIST_MAX, Math.round(Number(input.count) || 10)));
    const r = await findUserPlaylist(name, { limit: count, shuffle: !!input.shuffle, q: String(input.search || "").trim() }, input);
    if (!r.ok) return r.msg;
    if (!r.songs.length) return "「" + r.playlist.name + "」里没有能放的歌。";
    const s = sources[r.src];
    const midOf = (x) => x.mid || bareId(x.id);
    let first = -1, firstGot = null;
    for (let i = 0; i < Math.min(3, r.songs.length); i++) {
      const g = await SRC[r.src].byId(s, midOf(r.songs[i]), hintOf(r.songs[i]));
      if (g.ok) { first = i; firstGot = g; break; }
      if (g.login) return g.msg;
    }
    if (first < 0) return "「" + r.playlist.name + "」开头几首都下不下来(可能是单独付费的),换个歌单或者 shuffle 试试。";
    const songs = r.songs.slice(first);
    s.addPending(songs.slice(1).map((x) => Object.assign({ mid: midOf(x), id: midOf(x) }, hintOf(x))), midOf(songs[0]));
    const list = songs.map((x, i) => ({ title: x.name + " - " + x.artist, url: i === 0 ? firstGot.track.url : s.urlFor(midOf(x)) }));
    let total = 0;
    for (const x of songs) total += x.interval || 0;
    const seconds = secondsOf(input), volume = clampVolume(input.volume);
    const title = srcLabel(r.src) + "歌单「" + r.playlist.name + "」";
    const fail = send(ctx, { action: "play", title, seconds, volume, total, list });
    if (fail) return fail;
    return "好了:" + title + (input.shuffle ? "随机" : "按顺序") + "放 " + songs.length + " 首(" + mmss(total) + ")," + howLongText(seconds, total, !!input.loop) +
      "。头一首是 «" + songs[0].name + " - " + songs[0].artist + "»," + U + "手机几秒内开始放;后面的边放边提前下好下一首,偶尔一首下不来会跳过。曲目:" +
      songs.map((x) => x.name).join(" / ") + "。要停用 action=stop。";
  }

  // ── 你自己的歌单 ──
  async function myPlaylist(input, ctx) {
    const name = String(input.track || input.playlist || "").trim();
    if (!name) {
      const all = playlists.list();
      if (!all.length) return "你还没建过歌单。用 action=playlist_add 建(playlist=歌单名,track=曲库里的曲名、qq-…/ne-… 歌号或「歌名 歌手」)。";
      return "你自己建的歌单:\n" + all.map((p) => "· " + p.name + " — " + p.items.length + " 首" + (p.description ? "(" + p.description.slice(0, 40) + ")" : "")).join("\n") +
        "\n放进电话:action=my_playlist,track=歌单名(可加 shuffle / count / loop);看里面有什么:action=my_playlist 配 track 和 search=?";
    }
    const p = playlists.find(name);
    if (!p) return "没有叫「" + name.slice(0, 40) + "」的歌单。action=my_playlist 不带 track 看你有哪些。";
    if (input.search === "?") return "「" + p.name + "」" + p.items.length + " 首:\n" + p.items.map((x) => x.ref + "  " + x.title).join("\n");
    const fail0 = fmtFail(channel.status(ctx.callId));
    if (fail0) return fail0;
    if (!p.items.length) return "「" + p.name + "」是空的,先用 action=playlist_add 往里加歌。";
    const lib = library.list();
    let items = (input.shuffle ? shuffled(p.items) : p.items.slice()).map((x) => {
      if (x.ref.startsWith("lib:")) { const t = lib.find((y) => y.id === x.ref.slice(4)); return t ? { kind: "lib", t, title: t.title } : null; }
      const n = srcOfId(x.ref);
      return n && sources[n] && sources[n].enabled() ? { kind: n, id: bareId(x.ref), title: x.title } : null;
    }).filter(Boolean);
    const skipped = p.items.length - items.length;
    items = items.slice(0, Math.max(1, Math.min(LIST_MAX, Math.round(Number(input.count) || LIST_MAX))));
    if (!items.length) return "「" + p.name + "」里的歌现在都放不了(曲库里删了,或者音源没开)。";
    // 第一首要当场能放:曲库的直接放;音源的先下好(下不成往后找,最多试 3 首)
    let first = -1, firstUrl = "", firstDur = 0;
    for (let i = 0, tries = 0; i < items.length && tries < 3; i++) {
      const it = items[i];
      if (it.kind === "lib") { first = i; firstUrl = it.t.url; firstDur = it.t.duration || await durationOf(it.t.file); break; }
      tries++;
      const g = await SRC[it.kind].byId(sources[it.kind], it.id, null);
      if (g.ok) { first = i; firstUrl = g.track.url; firstDur = g.track.duration || 0; if (g.track.title) it.title = g.track.title; break; }
      if (g.login) return g.msg;
    }
    if (first < 0) return "「" + p.name + "」开头几首都拿不到,换几首再试。";
    items = items.slice(first);
    for (const n of Object.keys(SRC)) {
      const rest = items.slice(1).filter((x) => x.kind === n);
      if (rest.length) sources[n].addPending(rest.map((x) => ({ mid: x.id, id: x.id, name: x.title, artist: "", interval: 0 })), items[0].kind === n ? items[0].id : null);
    }
    const list = items.map((x, i) => ({ title: x.title, url: i === 0 ? firstUrl : x.kind === "lib" ? x.t.url : sources[x.kind].urlFor(x.id) }));
    let total = firstDur;
    for (const x of items.slice(1)) total += x.kind === "lib" ? (x.t.duration || await durationOf(x.t.file)) : 240;   // 没下的按 4 分钟估,只用来报「还剩多久」
    const seconds = secondsOf(input), volume = clampVolume(input.volume);
    const title = "你的歌单「" + p.name + "」";
    const fail = send(ctx, { action: "play", title, seconds, volume, total, list });
    if (fail) return fail;
    return "好了:" + title + (input.shuffle ? "随机" : "按顺序") + "放 " + items.length + " 首," + howLongText(seconds, total, !!input.loop) +
      "。头一首 «" + list[0].title + "»," + U + "手机几秒内开始放;后面的边放边提前下。" + (skipped ? "有 " + skipped + " 首现在放不了,跳过了。" : "") +
      "曲目:" + items.map((x) => x.title).join(" / ") + "。";
  }

  async function playlistAdd(input) {
    const name = String(input.playlist || "").trim();
    const track = String(input.track || "").trim();
    if (!name || !track) return "action=playlist_add 要写 playlist=歌单名 和 track=要加的歌(曲库里的曲名、qq-…/ne-… 歌号,或「歌名 歌手」)。";
    let item = null, note = "";
    if (ID_RE.test(track)) item = { ref: track, title: String(input.title || "").trim() || track };
    else {
      const hit = resolveTrack(track, library.list());
      if (hit && !hit.all && hit.tracks.length === 1) item = { ref: "lib:" + hit.tracks[0].id, title: hit.tracks[0].title };
      else if (order().length) {
        const got = await fetchFromSources(track, input);   // 顺手下进缓存,打电话时放得快
        if (!got.ok) return got.msg;
        item = { ref: refOf(got.src, got.track), title: got.track.title };
        note = "(在" + srcLabel(got.src) + "找到的,已经下进缓存)";
      } else return "曲库里没有「" + track.slice(0, 40) + "」,服务器也没配置音源。";
    }
    let r;
    try { r = playlists.add(name, item, input.description); } catch (e) { if (e.bad) return "没加进去:" + e.message + "。"; throw e; }
    if (r.dup) return "「" + r.playlist.name + "」里已经有 «" + item.title + "» 了。";
    return (r.created ? "新建了歌单「" + r.playlist.name + "」," : "") + "把 «" + item.title + "»" + note + " 加进「" + r.playlist.name + "」了,现在 " + r.playlist.items.length + " 首。";
  }

  async function playlistRemove(input) {
    const name = String(input.playlist || "").trim();
    if (!name) return "action=playlist_remove 要写 playlist=歌单名(track 写要删的那首;不写 track = 删掉整张歌单)。";
    try {
      const r = playlists.remove(name, String(input.track || "").trim());
      return r.whole ? "删掉了整张歌单「" + r.playlist.name + "」。" : "从「" + r.playlist.name + "」删了 «" + r.item.title + "»,还剩 " + r.playlist.items.length + " 首。";
    } catch (e) { if (e.bad) return "没删:" + e.message + "。"; throw e; }
  }

  async function add(input) {
    const url = String(input.url || "").trim();
    if (!url) return "要给 url:音频文件的直链,或者 download:导入目录里的文件名。";
    const title = String(input.title || "").trim() || require("./library.js").titleFromName(url.split(/[?#]/)[0]);
    if (!title) return "要给 title(这首叫什么)。";
    const license = String(input.license || "").trim();
    if (!license) return "要写 license:它的授权是什么(CC0、公版、CC BY 4.0 · 作者名…)。确认不了就别放。";
    let r;
    try {
      r = await library.addFrom(url, { title, license, added_by: "ai", source: String(input.source || "").trim() });
    } catch (e) {
      if (e && e.bad) return "没放进去:" + e.message + "。";
      throw e;
    }
    const t = r.track;
    if (r.dup) return "这首曲库里已经有了:«" + t.title + "»(" + (t.added_by === "ai" ? "你" : U) + "放的),没重复存。";
    return "放进曲库了:«" + t.title + "» " + mmss(t.duration) + (t.license ? ",授权记的是「" + t.license + "」" : "") + "。打电话时 track 写「" + t.title + "」就能放。";
  }

  async function remove(input) {
    const q = String(input.track || input.title || "").trim();
    if (!q) return "要删哪首?track 写曲名。";
    const t = library.find(q);
    if (!t) return "曲库里没有「" + q.slice(0, 40) + "」。";
    try { await library.remove(t.id, "ai"); } catch (e) { if (e && e.bad) return "没删:" + e.message + "。"; throw e; }
    return "从曲库删掉了:«" + t.title + "»。";
  }

  function downloads() {
    if (!(cfg.importDirs || []).length) return "服务器没开导入目录(PHONE_MUSIC_IMPORT_DIRS),这个用不了。";
    const items = library.listDownloads(48 * 3600 * 1000);
    if (!items.length) return "导入目录里两天内没有音频。下载好以后再看,然后 action=add,url 写 download:文件名。";
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? m + " 分钟前" : Math.round(m / 60) + " 小时前"; };
    return "导入目录里的音频(新的在前):\n" + items.slice(0, 15).map((d) => "· " + d.name + " · " + (d.bytes / 1048576).toFixed(1) + "MB · " + ago(d.mtime)).join("\n") +
      "\n收进曲库:action=add,url 写 download:文件名,title、license 照写。";
  }

  function stop(ctx) {
    const st = channel.status(ctx.callId);
    const fail = fmtFail(st);
    if (fail) return fail;
    const herStopped = st.page && st.music && st.page.seq === st.music.seq && st.page.state === "her";
    const wasPlaying = st.music && st.music.action === "play" && !(st.page && st.page.seq === st.music.seq && st.page.state !== "playing");
    const f2 = send(ctx, { action: "stop" });
    if (f2) return f2;
    if (herStopped) return U + "那边已经自己停了。";
    return wasPlaying ? "停了," + U + "手机几秒内收到。" : "电话里本来就没在放(停的指令也发了)。";
  }

  async function listAll() {
    const parts = [await catalogText()];
    for (const n of order()) {
      const c = sources[n].listCached ? sources[n].listCached() : [];
      parts.push(srcLabel(n) + ":开着,任何歌都能用 action=song 点" + (c.length ? ";缓存里已经有:" + c.slice(0, 20).map((t) => t.title).join(" / ") + (c.length > 20 ? " 等 " + c.length + " 首" : "") : "") + "。");
    }
    const mine = playlists.list();
    if (mine.length) parts.push("你自己的歌单:" + mine.map((p) => p.name + "(" + p.items.length + ")").join(" / ") + "(action=my_playlist)。");
    return parts.join("\n");
  }

  function statusText(ctx) {
    const st = channel.status(ctx.callId);
    const fail = fmtFail(st);
    if (fail) return fail;
    return channel.fact(ctx.callId);
  }

  async function handle(input, ctx) {
    input = input || {};
    ctx = Object.assign({ callId: input.call_id || null }, ctx || {});
    const action = input.action || (input.track ? "play" : "list");
    try {
      switch (action) {
        case "play": return await play(input, ctx);
        case "song": return await song(input, ctx);
        case "playlists": return await userPlaylists(input);
        case "playlist": return await userPlaylistPlay(input, ctx);
        case "my_playlist": return await myPlaylist(input, ctx);
        case "playlist_add": return await playlistAdd(input);
        case "playlist_remove": return await playlistRemove(input);
        case "stop": return stop(ctx);
        case "status": return statusText(ctx);
        case "list": return await listAll();
        case "add": return await add(input);
        case "remove": return await remove(input);
        case "downloads": return downloads();
        default: return "action 只认:" + actions().join(" / ") + "。";
      }
    } catch (e) {
      return "phone_music 自己出错了:" + (e && e.message ? e.message : String(e)) + "。";
    }
  }

  // ── 给 AI 的说明(按服务器开了哪些东西现拼) ──
  function actions() {
    const a = ["play", "stop", "status", "list", "add", "remove", "my_playlist", "playlist_add", "playlist_remove"];
    if (order().length) a.splice(1, 0, "song", "playlists", "playlist");
    if ((cfg.importDirs || []).length) a.push("downloads");
    return a;
  }
  function description() {
    const srcs = order();
    const srcNames = srcs.map(srcLabel).join(" / ");
    const lines = [
      "电话里放歌:" + U + "跟你通着电话的时候,往电话里放音乐(叫" + U + "起床、番茄钟休息、哄" + U + "睡觉、想放首歌给" + U + "听的时候)。",
      "action=play 配 track 放曲库里的(写曲名,或者写「曲库」整个连着放);seconds=放多久(不给就放完,最多 3600);volume 0.1~1,默认 0.6。",
      "action=stop 停;action=status 看电话里现在放着什么、还剩多久;action=list 看能放什么。",
      "曲库是你和" + U + "一起攒的:" + U + "在曲库页传,你用 action=add 往里放——url 写音频文件直链(.mp3/.ogg/.flac/.wav 这类,不是网页),title 起个名字,license 必须写(CC0、公版、CC BY 4.0 · 作者名),只放版权允许的。action=remove 配 track,只能删你自己放的。",
    ];
    if ((cfg.importDirs || []).length) lines.push("直链拿不到(403、要登录)的:在你的浏览器里把音频下载下来,action=downloads 看下载了哪些,再 add,url 写 download:文件名。");
    if (srcs.length) {
      lines.push("流行歌(" + srcNames + "):action=song,track 写「歌名 歌手」(比如 月亮代表我的心 邓丽君),会找到那首、下进缓存再放;同一首第二次放直接用缓存。也可以写 qq-… / ne-… 歌号;source=qq/netease 只在那一家找。");
      lines.push(U + "在音源里的歌单(只读):action=playlists 列出来,配 track=歌单名 看里面的歌(search 按歌名/歌手筛);action=playlist 配 track=歌单名 连着放,count=放几首(默认 10,最多 30),shuffle=true 随机抽。");
    }
    lines.push("你自己的歌单:action=playlist_add 配 playlist=歌单名、track=要加的歌(曲库曲名" + (srcs.length ? "、歌号或「歌名 歌手」" : "") + "),没有这个歌单就新建;action=playlist_remove 删一首(不写 track 删整张);action=my_playlist 不带 track 列出来,带 track=歌单名放进电话。");
    lines.push("循环:play / song / playlist / my_playlist 都可以加 loop=true,单曲或整张单一直绕着放,直到 stop(最多 8 小时;配 seconds 就放那么久)。");
    lines.push("没在打电话就直接告诉你,什么都不做。放着的时候你照常说话,音乐会自动压低垫在你声音底下;" + U + "一开口也会压低;" + U + "说「暂停」「继续」「停」或点屏幕上的按钮都行。");
    return lines.join("");
  }
  function inputSchema() {
    const srcs = order().length > 0;
    const props = {
      action: { type: "string", enum: actions(), description: "要做什么。不给:有 track 就是 play,没有就是 list" },
      track: { type: "string", description: "play:曲名或「曲库」;" + (srcs ? "song:「歌名 歌手」或歌号;playlists / playlist:" + U + "的歌单名;" : "") + "my_playlist:你的歌单名;playlist_add / playlist_remove:要加 / 删的那首;remove:要删的曲名" },
      playlist: { type: "string", description: "playlist_add / playlist_remove 用:你的歌单名" },
      loop: { type: "boolean", description: "循环:一直绕着放,直到 stop(最多 8 小时;配 seconds 就放那么久)" },
      seconds: { type: "integer", minimum: 1, maximum: LOOP_MAX, description: "放多久(秒)。不给就放完;不循环最多 3600" },
      volume: { type: "number", minimum: 0.1, maximum: 1, description: "多响,0.1~1,默认 0.6" },
      shuffle: { type: "boolean", description: "随机顺序" },
      count: { type: "integer", minimum: 1, maximum: LIST_MAX, description: "playlist / my_playlist 用:放几首" },
      search: { type: "string", description: "playlists / playlist 用:只要歌名或歌手含这个的" },
      url: { type: "string", description: "add 用:音频文件直链(http/https)" + ((cfg.importDirs || []).length ? ",或 download:文件名" : "") },
      title: { type: "string", description: "add 用:这首叫什么;playlist_add 加歌号时可以顺便写歌名" },
      license: { type: "string", description: "add 用,必填:授权(CC0、公版、CC BY 4.0 · 作者名…)" },
      source: { type: "string", description: "add 用,可选:从哪儿拿的(原网页地址)" + (srcs ? ";song / playlists / playlist 用:qq 或 netease,只在那一家找" : "") },
      description: { type: "string", description: "playlist_add 新建歌单时可选:这张歌单是干什么的" },
    };
    if (!srcs) delete props.search;
    if (!(cfg.importDirs || []).length) props.url.description = "add 用:音频文件直链(http/https)";
    return { type: "object", properties: props };
  }
  function definition() {
    return { name: "phone_music", description: description(), input_schema: inputSchema() };
  }

  return { handle, definition, description, inputSchema, actions, _test: { secondsOf, clampVolume } };
}

module.exports = { createTool, LOOP_MAX, MAX_SECONDS };
