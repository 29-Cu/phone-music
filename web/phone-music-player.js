/*
 * phone-music-player.js — 手机网页上的播放端。把它接进你自己的「跟 AI 打电话」页面。
 *
 *   var pm = PhoneMusic.create({ server: "", token: "…", onChange: function (s) {…}, onNote: function (msg) {…} });
 *   接通按钮的点击里:pm.unlock(); pm.start();
 *   AI 开始 / 停止出声:pm.setAiSpeaking(true / false)
 *   用户开始 / 停止说话(你的 VAD):pm.setUserSpeaking(true / false)
 *   AI 在想(回话在路上):pm.setAiThinking(true / false)
 *   按住说话按着:pm.setHold(true / false)
 *   识别出用户说的一句话:pm.userSaid(text)  → "stop" / "pause" / "resume" / null(只是「停」「暂停」「继续」这种整句才算)
 *   屏幕按钮:pm.pause() / pm.resume() / pm.stop()
 *   挂断:pm.end()
 *
 * 它做的事:
 *   - 每 2.5 秒问服务器一次(GET /api/music/pending),顺带回报「seq:playing|idle|her」,AI 那边据此知道歌还在不在放;
 *   - AI 说话时歌压到三成,用户说话时压到两成,按住说话时静音;压低快、回来慢;定了时长的到点前两秒淡出;
 *   - 一首放完接下一首;定了秒数(或循环)就绕着单子转到点;一首放不出就跳过,全放不出就停并提示;
 *   - 「暂停」= 停在原处:用户暂停以后再开口说一句、两边都静下来 1.5 秒,就从原处接着放(也可以说「继续」/点继续);
 *     「停」= 这一段不放了。
 *
 * iPhone 上要注意的(都是真机踩过的):
 *   - audio.volume 在 iOS 上改不了,所以歌走 Web Audio 的增益节点;
 *   - unlock() 必须在用户点击的那一下里调用(iOS 不让手势外第一次 play);
 *   - 放歌的 AudioContext 在第一次放歌时才建:比麦克风先建的话,它会定死在外放的采样率,一拿麦 iOS 换成通话档,
 *     两边采样率对不上,AI 说话时整路声音「次啦」。你的页面要是一接通就拿麦,这里自然就排在麦后面;
 *   - 外放时 iPhone 的回声消除会把歌从麦里减掉,所以放歌时麦不用关(老机型漏音的话,自己在放歌时关麦);
 *   - 歌和页面不同域名时,audio 要 crossOrigin="anonymous",服务器要配 PHONE_MUSIC_CORS_ORIGIN,不然 Web Audio 只出静音。
 */
(function (root) {
  "use strict";

  var SILENT_MP3 = "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP//////////////////////////////////////////8AAAA5TEFNRTMuOThyAc0AAAAAAAAAABSAJAJAQgAAgAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//sQxAADwAABpAAAACAAADSAAAAETEFNRTMuOTguMlVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//sQxCkDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
  var STOP_RE = /^\s*(?:停|停下|停停|别放了|不要放了|不放了|关掉|关了|关掉音乐|把歌关了|stop|stop it|stop the music|turn it off)[\s。.!！~～,，]*$/i;
  var PAUSE_RE = /^\s*(?:暂停|暂停一下|先暂停|停一下|先停一下|pause|pause it)[\s。.!！~～,，]*$/i;
  var RESUME_RE = /^\s*(?:继续|继续放|继续吧|接着放|接着放吧|放吧|resume|continue|play)[\s。.!！~～,，]*$/i;

  function create(opts) {
    opts = opts || {};
    var server = String(opts.server || "").replace(/\/+$/, "");
    var token = opts.token || "";
    var callId = opts.callId || ("c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    var POLL_MS = opts.pollMs || 2500;
    var DUCK_AI = opts.duckAi != null ? opts.duckAi : 0.3;
    var DUCK_USER = opts.duckUser != null ? opts.duckUser : 0.2;
    var MAX_AGE_MS = 120000;           // 页面从后台回来拿到两分钟前的指令:过时了,不放
    var RESUME_QUIET_MS = 1500;
    var onChange = opts.onChange || function () {};
    var onNote = opts.onNote || function () {};

    var el = null, ctx = opts.audioContext || null, gain = null, src = null;
    var cmd = null, on = false, paused = false, idx = 0, errs = 0, deadline = 0, seqDone = 0, state = "idle";
    var tickT = 0, fadeT = 0, cur = -1, pausedAt = 0, pauseArmed = false, quietSince = 0, leftMs = 0;
    var aiSpeaking = false, aiThinking = false, userSpeaking = false, userSince = 0, hold = false, holdSince = 0;
    var pollT = 0, polling = false, asking = false, ended = false;

    function now() { return Date.now(); }
    function abs(u) {
      if (/^(https?:|data:|blob:)/.test(u)) return u;
      return server + u;
    }
    function withToken(u) {
      if (!token || /^(data:|blob:)/.test(u)) return u;
      return u + (u.indexOf("?") >= 0 ? "&" : "?") + "t=" + encodeURIComponent(token);
    }
    function crossOrigin() {
      try { return !!server && new URL(server, location.href).origin !== location.origin; } catch (e) { return false; }
    }

    // ── 解锁 / 引擎 ──
    function unlock() {
      if (el) return;
      try {
        el = new Audio();
        el.setAttribute("playsinline", "");
        el.preload = "auto";
        if (crossOrigin()) el.crossOrigin = "anonymous";
        el.src = SILENT_MP3;
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) { el = null; }
    }
    function ensureCtx() {
      if (ctx) return;
      try {
        var AC = root.AudioContext || root.webkitAudioContext;
        ctx = AC ? new AC() : null;
        if (ctx && ctx.resume) ctx.resume().catch(function () {});
      } catch (e) { ctx = null; }
    }
    function graph() {
      if (gain) return true;
      ensureCtx();
      if (!ctx || !el) return false;
      if (ctx.state !== "running") { try { ctx.resume(); } catch (e) {} if (ctx.state !== "running") return false; }
      try {
        src = ctx.createMediaElementSource(el);
        gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain); gain.connect(ctx.destination);
      } catch (e) { gain = null; }
      return !!gain;
    }

    // ── 指令 ──
    function handleCommand(c) {
      if (!c || !c.seq || c.seq <= seqDone) return;
      seqDone = c.seq;
      if (c.action === "stop") { stop("ai"); return; }
      if (c.action !== "play" || !c.list || !c.list.length) return;
      if (c.age_ms > MAX_AGE_MS) return;
      stop(null, true);
      cmd = c; idx = 0; errs = 0;
      if (!el) unlock();
      on = true; paused = false; state = "playing";
      deadline = c.seconds > 0 ? now() + c.seconds * 1000 : 0;
      playTrack();
      clearInterval(tickT); tickT = setInterval(tick, 100);
    }
    function playTrack() {
      if (!on || !cmd || !el) return;
      var t = cmd.list[idx % cmd.list.length];
      graph();
      level(0, true);                        // 每一首从零淡进来
      el.onended = function () { next(false); };
      el.onerror = function () { next(true); };
      el.onplaying = function () { errs = 0; };
      el.src = withToken(abs(t.url));
      var p = el.play();
      if (p && p.catch) p.catch(function (e) {
        if (!on) return;
        onNote("音乐没放出来:" + (e && e.message ? e.message : e));
        stop(null);
      });
      emit();
    }
    function next(err) {
      if (!on || !cmd) return;
      if (err && ++errs >= cmd.list.length) { onNote("音乐没放出来"); stop(null); return; }
      idx++;
      var more = deadline ? now() < deadline - 1500 : idx < cmd.list.length;
      if (more) playTrack(); else stop("done");
    }
    function target() {
      if (!on || !cmd) return 0;
      var base = cmd.volume > 0 ? Math.min(1, cmd.volume) : 0.6, t = now();
      if (hold) return 0;                                   // 按住说话:歌静音
      var v = base;
      if (aiSpeaking) v = base * DUCK_AI;                   // AI 在说:垫在底下
      else if (userSpeaking) v = base * DUCK_USER;          // 用户在说
      if (deadline && deadline - t < 2000) v = Math.min(v, base * Math.max(0, (deadline - t) / 2000));   // 到点前两秒淡出
      return v;
    }
    function level(v, jump) {
      if (gain && ctx) {
        try {
          var t0 = ctx.currentTime;
          if (jump) { gain.gain.cancelScheduledValues(t0); gain.gain.setValueAtTime(v, t0); }
          else gain.gain.setTargetAtTime(v, t0, v < cur ? 0.06 : 0.25);   // 压低快、回来慢
        } catch (e) {}
      } else if (el) {
        try { el.volume = Math.max(0, Math.min(1, v)); } catch (e) {}   // 没接上 Web Audio 时的退路(iOS 上不起作用)
      }
      cur = v;
    }
    function quiet() { return !aiSpeaking && !aiThinking && !userSpeaking && !hold; }
    function tick() {
      if (paused) { pauseWatch(); return; }
      if (!on) return;
      if (deadline && now() >= deadline) { stop("done"); return; }
      var v = target();
      if (Math.abs(v - cur) > 0.005) level(v);
    }
    // 暂停着:等用户「暂停以后」开口说一句(说「暂停」的那一句本身不算),再等两边都静下来 1.5 秒,从原处接着放。
    // AI 自己说话不算:用户点了暂停,AI 说一句歌不会回来。
    function pauseWatch() {
      if (!pauseArmed && ((userSpeaking && userSince > pausedAt) || (hold && holdSince > pausedAt))) pauseArmed = true;
      if (!pauseArmed) return;
      if (!quiet()) { quietSince = 0; return; }
      var t = now();
      if (!quietSince) quietSince = t;
      else if (t - quietSince >= RESUME_QUIET_MS) resume();
    }
    function pause() {
      if (!on || !cmd || !el) return;
      var t = now();
      on = false; paused = true; pausedAt = t; pauseArmed = false; quietSince = 0;
      leftMs = deadline ? Math.max(0, deadline - t) : 0;   // 定了放多久的:暂停的这段不算
      deadline = 0;
      state = "her";
      var me = el;
      clearTimeout(fadeT);
      if (gain) { level(0); fadeT = setTimeout(function () { if (!on) { try { me.pause(); } catch (e) {} } }, 400); }
      else { try { me.pause(); } catch (e) {} }
      emit(); kick();
    }
    function resume() {
      if (!paused || !cmd || !el || ended) return;
      clearTimeout(fadeT); fadeT = 0;
      paused = false; on = true; state = "playing"; quietSince = 0;
      if (cmd.seconds > 0) {
        if (leftMs < 1000) { stop("done"); return; }
        deadline = now() + leftMs;
      }
      if (el.ended) { next(false); return; }
      graph();
      level(0, true);
      var p = el.play();
      if (p && p.catch) p.catch(function (e) {
        if (!on) return;
        onNote("音乐没接上:" + (e && e.message ? e.message : e));
        stop(null);
      });
      if (!tickT) tickT = setInterval(tick, 100);
      emit(); kick();
    }
    // why:her = 用户停的;ai = AI 让停的;done = 放完 / 到点;null = 别的(出错、换歌、挂断)
    function stop(why, quick) {
      clearInterval(tickT); tickT = 0;
      var wasPlaying = on, wasOn = on || paused;
      on = false; paused = false; pauseArmed = false; leftMs = 0; cmd = null; deadline = 0;
      state = why === "her" ? "her" : "idle";
      if (el) {
        el.onended = el.onerror = el.onplaying = null;
        if (wasPlaying && !quick && gain) {
          level(0);
          var me = el;
          clearTimeout(fadeT);
          fadeT = setTimeout(function () { if (!on) { try { me.pause(); } catch (e) {} } }, 600);
        } else { try { el.pause(); } catch (e) {} }
      }
      emit();
      if (wasOn && why === "her") { onNote("音乐停了"); kick(); }
    }

    // ── 用户 / AI 的状态 ──
    function userSaid(text) {
      var s = String(text || "");
      if ((on || paused) && STOP_RE.test(s)) { stop("her"); return "stop"; }
      if (on && PAUSE_RE.test(s)) { pause(); return "pause"; }
      if (paused && RESUME_RE.test(s)) { resume(); return "resume"; }
      return null;
    }
    function setUserSpeaking(b) { b = !!b; if (b && !userSpeaking) userSince = now(); userSpeaking = b; }
    function setHold(b) { b = !!b; if (b && !hold) holdSince = now(); hold = b; }

    // ── 和服务器 ──
    function report() { return seqDone + ":" + state; }
    function kick() { if (polling) setTimeout(poll, 0); }   // 用户自己停 / 暂停了:马上告诉服务器,不等下一次
    function poll() {
      if (!polling || asking || ended) return;
      asking = true;
      var u = server + "/api/music/pending?call_id=" + encodeURIComponent(callId) + "&ms=" + encodeURIComponent(report());
      fetch(u, { headers: token ? { Authorization: "Bearer " + token } : {}, cache: "no-store", credentials: server ? "omit" : "include" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.music) handleCommand(j.music); })
        .catch(function () {})
        .then(function () { asking = false; });
    }
    function start() {
      if (!el) unlock();
      if (opts.poll === false || polling) return;
      polling = true; ended = false;
      poll();
      pollT = setInterval(poll, POLL_MS);
    }
    function end() {
      stop(null, true);
      ended = true; polling = false;
      clearInterval(pollT); pollT = 0;
      if (opts.poll !== false) {
        fetch(server + "/api/music/end?call_id=" + encodeURIComponent(callId), { method: "POST", headers: token ? { Authorization: "Bearer " + token } : {}, credentials: server ? "omit" : "include" }).catch(function () {});
      }
    }

    function snapshot() {
      var title = cmd ? (cmd.list[idx % cmd.list.length] || {}).title || "" : "";
      var m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(String(title));   // 「歌名 - 歌手」
      return {
        state: on ? "playing" : paused ? "paused" : "idle",
        title: m ? m[1] : title, artist: m ? m[2] : "", listTitle: cmd ? cmd.title || "" : "",
        index: idx, count: cmd ? cmd.list.length : 0,
        pos: el && (on || paused) ? el.currentTime || 0 : 0, dur: el && isFinite(el.duration) ? el.duration : 0,
        level: Math.max(0, cur), deadline: deadline, callId: callId, report: report(),
      };
    }
    function emit() { try { onChange(snapshot()); } catch (e) {} }

    return {
      unlock: unlock, start: start, end: end,
      handleCommand: handleCommand, report: report,
      setAiSpeaking: function (b) { aiSpeaking = !!b; }, setAiThinking: function (b) { aiThinking = !!b; },
      setUserSpeaking: setUserSpeaking, setHold: setHold, userSaid: userSaid,
      pause: pause, resume: resume, stop: function () { stop("her"); },
      snapshot: snapshot, get callId() { return callId; },
    };
  }

  var api = { create: create, STOP_RE: STOP_RE, PAUSE_RE: PAUSE_RE, RESUME_RE: RESUME_RE };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PhoneMusic = api;
})(typeof window !== "undefined" ? window : this);
