"use strict";

// AI 自己的歌单:它亲手建、亲手往里放歌,打电话时整张放进来。
// 一首歌 = 曲库里的一首(lib)或音源里的一首(qq-… / ne-… 歌号)。
// 存在 <dataDir>/playlists.json:{ playlists:[{ id, name, description, created_at, items:[{ ref, title }] }] }
//   ref = "lib:<曲库id>" | "qq-<mid>" | "ne-<id>"

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { norm } = require("./catalog.js");

const NAME_MAX = 40, DESC_MAX = 120, ITEMS_MAX = 300, LISTS_MAX = 50;

function bad(msg) { const e = new Error(msg); e.bad = true; return e; }
function clean(s, max) { return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }

function createPlaylists(file) {
  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      return { playlists: Array.isArray(j.playlists) ? j.playlists : [] };
    } catch (e) { return { playlists: [] }; }
  }
  function write(db) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  }
  function findIn(db, name) {
    const n = norm(name);
    if (!n) return null;
    return db.playlists.find((p) => p.id === name) || db.playlists.find((p) => norm(p.name) === n) ||
      db.playlists.find((p) => norm(p.name).startsWith(n)) || null;
  }

  function list() { return read().playlists; }
  function find(name) { return findIn(read(), name); }

  // 往歌单里加一首;歌单不存在就建一个
  function add(name, item, description) {
    const nm = clean(name, NAME_MAX);
    if (!nm) throw bad("要写歌单名");
    const ref = String(item && item.ref || "");
    if (!/^(lib:[a-f0-9]{12}|qq-[0-9A-Za-z]{8,24}|ne-\d{1,15})$/.test(ref)) throw bad("这首的歌号不对");
    const db = read();
    let p = findIn(db, nm);
    let created = false;
    if (!p) {
      if (db.playlists.length >= LISTS_MAX) throw bad("歌单太多了(最多 " + LISTS_MAX + " 个)");
      p = { id: crypto.randomBytes(5).toString("hex"), name: nm, description: clean(description, DESC_MAX), created_at: new Date().toISOString(), items: [] };
      db.playlists.push(p);
      created = true;
    } else if (description) p.description = clean(description, DESC_MAX);
    if (p.items.some((x) => x.ref === ref)) return { playlist: p, created, dup: true };
    if (p.items.length >= ITEMS_MAX) throw bad("这个歌单满了(最多 " + ITEMS_MAX + " 首)");
    p.items.push({ ref, title: clean(item.title, 120) || ref });
    write(db);
    return { playlist: p, created, dup: false };
  }

  // 从歌单删一首(track = 曲名或歌号);不给 track = 删整张歌单
  function remove(name, track) {
    const db = read();
    const p = findIn(db, name);
    if (!p) throw bad("没有叫「" + clean(name, 40) + "」的歌单");
    if (!track) {
      db.playlists = db.playlists.filter((x) => x !== p);
      write(db);
      return { playlist: p, whole: true };
    }
    const n = norm(track);
    let i = p.items.findIndex((x) => x.ref === track || x.ref === "lib:" + track || norm(x.title) === n);
    if (i < 0 && n) i = p.items.findIndex((x) => norm(x.title).includes(n));
    if (i < 0) throw bad("「" + p.name + "」里没有「" + clean(track, 40) + "」");
    const [it] = p.items.splice(i, 1);
    write(db);
    return { playlist: p, item: it, whole: false };
  }

  return { list, find, add, remove };
}

module.exports = { createPlaylists };
