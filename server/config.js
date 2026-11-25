"use strict";

// 所有设置都从环境变量读,不给就用默认值。数据默认放在项目下的 ./data(已在 .gitignore 里)。

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");

function env(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
}
function list(name) {
  return String(env(name, "")).split(/[:,]/).map((s) => s.trim()).filter(Boolean);
}

function load() {
  const dataDir = path.resolve(env("PHONE_MUSIC_DATA", path.join(ROOT, "data")));
  const cfg = {
    root: ROOT,
    dataDir,
    host: env("HOST", "127.0.0.1"),
    port: Number(env("PORT", 3480)),
    // 给 AI 的工具说明里怎么称呼你(她 / 他 / TA / 名字)
    userWord: env("PHONE_MUSIC_USER", "TA"),
    // 网页播放端不在这台服务器的同一个域名下时,把那个页面的 origin 写进来(逗号分隔,* = 都行)
    corsOrigins: list("PHONE_MUSIC_CORS_ORIGIN"),
    // AI 可以从这几个目录里按文件名收音频进曲库(比如 AI 浏览器的下载目录、聊天上传目录)
    importDirs: list("PHONE_MUSIC_IMPORT_DIRS").map((d) => path.resolve(d)),
    libraryDir: path.join(dataDir, "library"),
    libraryJson: path.join(dataDir, "library.json"),
    playlistsJson: path.join(dataDir, "playlists.json"),
    // 一通电话的页面多久没来问 = 当它不在了
    staleMs: Number(env("PHONE_MUSIC_STALE_SEC", 60)) * 1000,
    // 从网上下载时允许内网地址(只在测试里用)
    allowLocalFetch: env("PHONE_MUSIC_ALLOW_LOCAL", "") === "1",
    sourcesOrder: list("PHONE_MUSIC_SOURCES").length ? list("PHONE_MUSIC_SOURCES") : ["qq", "netease"],
    qq: {
      cookieFile: path.resolve(env("QQ_COOKIE_FILE", path.join(dataDir, "qq", "cookie.txt"))),
      metaFile: path.resolve(env("QQ_META_FILE", path.join(dataDir, "qq", "meta.json"))),
      cacheDir: path.resolve(env("QQ_CACHE_DIR", path.join(dataDir, "qq", "cache"))),
      playlistCacheDir: path.join(dataDir, "qq", "playlists"),
      maxCacheBytes: Number(env("QQ_CACHE_MAX_MB", 2048)) * 1048576,
    },
    netease: {
      apiBase: env("NETEASE_API", ""),
      cookieFile: path.resolve(env("NETEASE_COOKIE_FILE", path.join(dataDir, "netease", "cookie.txt"))),
      cacheDir: path.resolve(env("NETEASE_CACHE_DIR", path.join(dataDir, "netease", "cache"))),
      playlistCacheDir: path.join(dataDir, "netease", "playlists"),
      maxCacheBytes: Number(env("NETEASE_CACHE_MAX_MB", 2048)) * 1048576,
    },
  };
  cfg.token = loadToken(cfg);
  return cfg;
}

// 访问口令:PHONE_MUSIC_TOKEN 给了就用它;没给就第一次启动时随机生成一个存进 data/token.txt
function loadToken(cfg) {
  const t = env("PHONE_MUSIC_TOKEN", "");
  if (t) return t;
  const f = path.join(cfg.dataDir, "token.txt");
  try {
    const s = fs.readFileSync(f, "utf8").trim();
    if (s) return s;
  } catch (_) {}
  const s = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(f, s + "\n", { mode: 0o600 });
  cfg.tokenCreated = true;
  return s;
}

module.exports = { load, ROOT };
