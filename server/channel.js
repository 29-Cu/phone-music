"use strict";

// 指令通道:AI 和手机之间的「传话筒」。
//
// 服务器不混音、不推流,每通电话只记「最新一条放歌指令」(play / stop,带递增的 seq)。
// 手机上的播放端每 2.5 秒来问一次(GET /api/music/pending),顺手带上自己的状态「seq:playing|idle|her」
// (her = 用户自己按了停 / 说了停)。所以:
//   - AI 调工具时,能当场知道「现在有没有在打电话」「播放端还在不在」,做不到就直说,不会假装放了;
//   - AI 每一轮都能拿到一句如实的「电话里现在放着什么、还剩多久」(fact()),不会以为歌还在放。
// 一通电话 = 一个 call_id。播放端第一次来问就算接通;一段时间(默认 60 秒)没来问就当它不在了。

function createChannel(opts) {
  opts = opts || {};
  const staleMs = opts.staleMs || 60000;
  const userWord = opts.userWord || "TA";
  const now = opts.now || (() => Date.now());
  const calls = new Map();   // id → { id, started, lastSeen, ended, seq, music, page, songs }

  function touch(id) {
    id = String(id || "").slice(0, 80);
    if (!/^[A-Za-z0-9_.:-]{4,80}$/.test(id)) return null;
    let c = calls.get(id);
    if (!c || c.ended) {
      c = { id, started: now(), lastSeen: now(), ended: false, seq: 0, music: null, page: null, songs: [] };
      calls.set(id, c);
      prune();
    }
    c.lastSeen = now();
    return c;
  }
  function end(id) {
    const c = calls.get(String(id || ""));
    if (c) c.ended = true;
    return !!c;
  }
  function prune() {
    const t = now();
    for (const [k, c] of calls) if (c.ended || t - c.lastSeen > 6 * 3600 * 1000) calls.delete(k);
  }

  // 工具调用时找「这通电话」:给了 call_id 就用它;没给 = 最近还在问的那一通
  function pick(callId) {
    if (callId) {
      const c = calls.get(String(callId));
      return c && !c.ended ? c : null;
    }
    let best = null;
    for (const c of calls.values()) if (!c.ended && (!best || c.lastSeen > best.lastSeen)) best = c;
    return best;
  }
  function live(callId) {
    const c = pick(callId);
    if (!c) return { error: "nocall" };
    const ago = now() - c.lastSeen;
    if (ago > staleMs) return { error: "stale", seen_s: Math.round(ago / 1000), call: c };
    return { call: c };
  }

  // cmd: { action:'play', title, list:[{title,url}], seconds, volume, total } | { action:'stop' }
  function setMusic(callId, cmd) {
    const r = live(callId);
    if (r.error) return r;
    const c = r.call;
    c.seq += 1;
    c.music = Object.assign({ seq: c.seq, ts: now() }, cmd);
    if (cmd.action === "play" && cmd.title && !c.songs.includes(cmd.title) && c.songs.length < 50) c.songs.push(String(cmd.title).slice(0, 80));
    return { call_id: c.id, seq: c.seq, page: c.page };
  }
  function status(callId) {
    const r = live(callId);
    if (r.error) return r;
    return { call_id: r.call.id, music: r.call.music, page: r.call.page };
  }

  // 播放端来问:记心跳、记它报的状态,把最新指令交给它
  function poll(callId, ms) {
    const c = touch(callId);
    if (!c) return null;
    const m = /^(\d+):(playing|idle|her)$/.exec(String(ms || ""));
    if (m) c.page = { seq: Number(m[1]), state: m[2], at: now() };
    const out = { call_id: c.id };
    if (c.music) out.music = Object.assign({}, c.music, { age_ms: now() - c.music.ts });
    return out;
  }

  // 给 AI 看的一句话:电话里现在放着什么(如实报)。适合每一轮塞进 AI 的上下文里
  function fact(callId) {
    const c = pick(callId);
    if (!c) return "现在没在打电话。";
    const m = c.music, pg = c.page, t = now();
    if (!m || m.action !== "play") return "电话里现在没在放声音。";
    const name = !m.title ? "的声音" : /[「」]/.test(m.title) ? String(m.title).slice(0, 40) : "「" + String(m.title).slice(0, 40) + "」";
    const samePage = pg && pg.seq === m.seq && t - pg.at < 20000;
    if (samePage && pg.state === "her") return "电话里放的" + name + userWord + "那头停掉了,现在没在放声音。";
    if (samePage && pg.state === "idle" && t - m.ts > 8000) return "电话里放的" + name + "已经停了,现在没在放声音。";
    const len = Number(m.seconds) || Number(m.total) || 0;
    if (!len) return "电话里还在放" + name + "。";
    const left = Math.round(len - (t - m.ts) / 1000);
    if (left <= 20) return samePage && pg.state === "playing" ? "电话里放的" + name + "快放完了。" : "电话里放的" + name + "应该已经放完了,现在没在放声音。";
    return "电话里还在放" + name + ",大概还剩 " + (left >= 5400 ? Math.round(left / 360) / 10 + " 小时" : left >= 90 ?Math.round(left / 60) + " 分钟" : left + " 秒") + "。";
  }

  return { touch, end, poll, setMusic, status, fact, pick, _calls: calls };
}

module.exports = { createChannel };
