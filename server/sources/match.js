'use strict';

// 版本比对和歌单查找:QQ 音乐和网易云共用。
//
// 同一首歌在曲库里常有好几版(原版、现场、伴奏、翻唱、合辑里的同一首……)。
// 这里给候选打分,用来在「这一版放不了」时找同一首的别的版本。分数规则:
//   歌名:完全一致 3 / 去掉括号后一致 2 / 一个包含另一个 1 / 都不是 → 不算(-1)
//   歌手:有交集或互相包含 +2
//   时长:差 ≤3 秒 +2 / ≤10 秒 +1 / >30 秒 -2
//   候选本身短于 30 秒(试听片段、铃声)→ 不算
// 总分 < 4 视为不是同一首:歌名至少去括号后一致,且歌手或时长至少再对上一样。

const PUNCT = /[\s·・.,，。'"“”‘’!！?？()（）\[\]【】\-_:：/&、]+/g;
const BRACKET = /[(（\[【][^)）\]】]*[)）\]】]/g;
const MIN_SCORE = 4;

function fold(s) {
  return String(s || '').normalize('NFKC').toLowerCase();
}

// 去掉空白和标点,只留字
function norm(s) {
  return fold(s).replace(PUNCT, '');
}

// 去掉括号里的注释(「(Live)」「(伴奏)」之类)再 norm
function core(s) {
  return norm(fold(s).replace(BRACKET, ''));
}

// 按码点截断(不把一个汉字/emoji 劈成两半)
function cut(s, n) {
  return Array.from(String(s || '')).slice(0, n).join('');
}

// c = { name, artists: [..], interval /* 秒 */ }
function score(wantName, wantArtists, wantDur, c) {
  const wn = norm(wantName);
  const cn = norm(c && c.name);
  if (!wn || !cn) return -1;
  let ns;
  if (wn === cn) ns = 3;
  else if (core(wantName) && core(wantName) === core(c.name)) ns = 2;
  else if (cn.includes(wn) || wn.includes(cn)) ns = 1;
  else return -1;

  const wa = [...new Set((wantArtists || []).map(norm).filter(Boolean))];
  const ca = [...new Set(((c && c.artists) || []).map(norm).filter(Boolean))];
  let art = 0;
  if (wa.length && ca.length && wa.some((x) => ca.some((y) => y.includes(x) || x.includes(y)))) art = 2;

  const wd = Number(wantDur) || 0;
  const ci = Number(c.interval) || 0;
  let ds = 0;
  if (wd && ci) {
    const diff = Math.abs(wd - ci);
    ds = diff <= 3 ? 2 : diff <= 10 ? 1 : diff > 30 ? -2 : 0;
  }
  if (ci && ci < 30) return -1;
  return ns + art + ds;
}

// 挑分最高的一版;最高分 < 4 → [null, 分数]
function pick(name, artists, dur, cands) {
  let best = null;
  let bestScore = -1;
  for (const c of cands || []) {
    const s = score(name, artists, dur, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (best === null || bestScore < MIN_SCORE) return [null, bestScore];
  return [best, bestScore];
}

// 「这一版放不了」时的替补:分数 ≥4 的候选,按分数从高到低(同分按原顺序),最多 3 个。
// cands 里要先去掉放不了的那一版。
function alternatives(name, artists, dur, cands) {
  return (cands || [])
    .map((c, i) => ({ c, i, s: score(name, artists, dur, c) }))
    .filter((x) => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.c);
}

// 用户说「我喜欢」「红心」之类时,直接指向账号自己的「我喜欢」歌单,
// 不会被收藏来的、恰好也叫「我喜欢」的别人的歌单抢走。
const LIKED_ALIASES = ['我喜欢', '喜欢', '我喜欢的', '红心', '收藏的歌', 'liked', '我的喜欢', '喜欢的歌'];

// pls = [{ id, name, count, kind:'liked'|'mine'|'fav', owner }],已按 liked → mine → fav 排好
function findPlaylist(pls, nameOrId) {
  const s = String(nameOrId == null ? '' : nameOrId).trim();
  if (!s) return null;
  for (const p of pls) if (p.id === s) return p;
  const ns = norm(s);
  if (LIKED_ALIASES.includes(ns)) return pls.find((p) => p.kind === 'liked') || null;
  const tests = [
    (n) => n === ns,
    (n) => n.startsWith(ns),
    (n) => n.includes(ns) || (Array.from(n).length >= 2 && ns.includes(n)),
  ];
  for (const t of tests) {
    for (const p of pls) if (t(norm(p.name))) return p;
  }
  return null;
}

// 歌单翻页:q 按歌名/歌手筛;shuffle 随机抽 limit 首;否则从 offset 起取 limit 首。limit 限在 1..200。
// songs 里每项要有 name 和 artists。
function pageSongs(songs, o) {
  o = o || {};
  let list = songs || [];
  if (o.q) {
    const nq = norm(o.q);
    list = list.filter((x) => norm(x.name).includes(nq) || (x.artists || []).some((a) => norm(a).includes(nq)));
  }
  const total = list.length;
  let limit = parseInt(o.limit, 10);
  if (!limit) limit = 30;
  limit = Math.max(1, Math.min(200, limit));
  if (o.shuffle) {
    const a = list.slice();
    const n = Math.min(limit, total);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return { total, songs: a.slice(0, n) };
  }
  const offset = Math.max(0, parseInt(o.offset, 10) || 0);
  return { total, songs: list.slice(offset, offset + limit) };
}

// 把「A, B」「A/B」或数组整理成歌手数组
function splitArtists(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  return String(v || '').split(/\s*,\s*|\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
}

module.exports = { fold, norm, core, cut, score, pick, alternatives, findPlaylist, pageSongs, splitArtists, MIN_SCORE, LIKED_ALIASES };
