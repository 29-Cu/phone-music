"use strict";

// 认歌:AI 写的 track(曲名、几个关键词)→ 曲库里的哪一首 / 整个曲库。
// 规则(按顺序,先到先得):曲名全等 → 曲名开头 → 曲名包含 / 每个词都在曲名里 / 曲名被 query 包含(query ≥4 字)。
// 不分大小写、不管重音(「gymnopedie 3」认得「Gymnopédie No.3」)。写「曲库」「全部」= 整个曲库连着放。

function fold(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
const SEP = /[\s·・.,，。'"“”‘’!！?？()（）\-_:：]+/g;
function norm(s) { return fold(s).replace(SEP, ""); }
function tokensIn(q, title) {
  const toks = fold(q).split(SEP).filter(Boolean);
  if (toks.length < 2) return false;
  const t = norm(title);
  return toks.every((k) => t.includes(k));
}

const ALL_WORDS = ["曲库", "全部", "歌单", "曲库里的", "library", "all"].map(norm);

// tracks: [{ title, url, file, duration }] → { tracks, title } | null
function resolve(query, tracks) {
  const q = String(query || "").trim();
  const nq = norm(q);
  if (!nq || !tracks || !tracks.length) return null;
  if (ALL_WORDS.includes(nq)) return { tracks: tracks.slice(), title: "曲库(" + tracks.length + " 首)", all: true };
  const tests = [
    (nt) => nt === nq,
    (nt) => nt.startsWith(nq),
    (nt, raw) => nt.includes(nq) || tokensIn(q, raw) || (nq.length >= 4 && nt.length >= 2 && nq.includes(nt)),
  ];
  for (const tt of tests) {
    for (const t of tracks) if (tt(norm(t.title), t.title)) return { tracks: [t], title: t.title };
  }
  return null;
}

function mmss(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

module.exports = { resolve, norm, fold, mmss };
