#!/usr/bin/env node
'use strict';

// 从一个「开着远程调试端口、已经登录了音乐网站」的 Chrome/Chromium 里读出登录 cookie,
// 写成服务端用的 cookie.txt(权限 600)和 meta.json(只记登录到期时间,不含 cookie 内容)。
//
//   node tools/qq-login.js [--site qq|netease] [--cdp http://127.0.0.1:9222] [--out ./data/qq]
//
// --site   qq(默认,读 *.qq.com)或 netease(读 *.music.163.com)
// --cdp    浏览器的调试地址(Chrome 用 --remote-debugging-port=9222 启动)
// --out    输出目录;不写时:有 QQ_COOKIE_FILE / NETEASE_COOKIE_FILE 就写到那个文件,
//          否则写到项目目录下的 data/qq/ 或 data/netease/
//
// 浏览器里已经没有登录(找不到登录 key)时,不覆盖原来的文件,只报出来,退出码 2。
// 只打印 cookie 的名字,从不打印值。零依赖(自带一个极简的 WebSocket 客户端,Node 18 也能跑)。

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SITES = {
  qq: {
    label: 'QQ 音乐',
    loginUrl: 'https://y.qq.com/',
    domain: /(^|\.)qq\.com$/,
    prefer: 'y.qq.com',              // 同名 cookie 在多个域上时,以 y.qq.com 的为准
    keys: ['qm_keyst', 'qqmusic_key'],
    env: 'QQ_COOKIE_FILE',
    dir: 'qq',
  },
  netease: {
    label: '网易云音乐',
    loginUrl: 'https://music.163.com/',
    domain: /(^|\.)music\.163\.com$/,
    prefer: 'music.163.com',
    keys: ['MUSIC_U'],
    env: 'NETEASE_COOKIE_FILE',
    dir: 'netease',
  },
};

function parseArgs(argv) {
  const o = { site: 'qq', cdp: 'http://127.0.0.1:9222', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(0, eq) : a;
    const v = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    if (k === '--site') o.site = String(v() || '').toLowerCase();
    else if (k === '--cdp') o.cdp = String(v() || '');
    else if (k === '--out') o.out = String(v() || '');
    else if (k === '-h' || k === '--help') o.help = true;
    else throw new Error('不认识的参数:' + a);
  }
  return o;
}

// ── 极简 WebSocket 客户端:发一条文本消息,等 id 对得上的那条回复 ──
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, total: off + len };
}

function cdpCall(wsUrl, id, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:') return reject(new Error('只支持 ws:// 的调试地址'));
    const key = crypto.randomBytes(16).toString('base64');
    let sock = null;
    let done = false;
    const timer = setTimeout(() => finish(new Error('等浏览器回话超时')), timeoutMs || 15000);
    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sock) {
        try { sock.end(encodeFrame(0x8, Buffer.alloc(0))); } catch (_) {}
        sock.destroy();
      }
      if (err) reject(err); else resolve(val);
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
    });
    req.on('upgrade', (res, socket, head) => {
      sock = socket;
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) return finish(new Error('WebSocket 握手不对'));
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      let parts = [];
      const onData = (d) => {
        if (d) buf = Buffer.concat([buf, d]);
        for (;;) {
          const f = decodeFrame(buf);
          if (!f) return;
          buf = buf.subarray(f.total);
          if (f.opcode === 0x8) return finish(new Error('浏览器关掉了连接'));
          if (f.opcode === 0x9) { socket.write(encodeFrame(0xA, f.payload)); continue; }
          if (f.opcode === 0xA) continue;
          parts.push(f.payload);
          if (!f.fin) continue;
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          let j = null;
          try { j = JSON.parse(text); } catch (_) { continue; }
          if (j && j.id === id) return finish(null, j);
        }
      };
      socket.on('data', onData);
      socket.on('error', (e) => finish(e));
      socket.on('close', () => finish(new Error('连接断了')));
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ id, method, params: params || {} }))));
      onData(null);
    });
    req.on('response', (res) => { res.resume(); finish(new Error('浏览器没接受 WebSocket(HTTP ' + res.statusCode + ')')); });
    req.on('error', (e) => finish(e));
    req.end();
  });
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function usage() {
  console.log([
    '用法: node tools/qq-login.js [--site qq|netease] [--cdp http://127.0.0.1:9222] [--out 目录]',
    '',
    '先用远程调试端口启动一个 Chrome/Chromium(单独的用户目录),在里面登录音乐网站,再跑这个。',
    '例: google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.config/phone-music-chrome',
  ].join('\n'));
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); usage(); return 1; }
  if (o.help) { usage(); return 0; }
  const site = SITES[o.site];
  if (!site) { console.error('--site 只能是 qq 或 netease'); return 1; }

  let cookieFile;
  if (o.out) cookieFile = path.join(path.resolve(o.out), 'cookie.txt');
  else if (process.env[site.env]) cookieFile = path.resolve(process.env[site.env]);
  else cookieFile = path.join(__dirname, '..', 'data', site.dir, 'cookie.txt');
  const metaFile = path.join(path.dirname(cookieFile), 'meta.json');

  const base = o.cdp.replace(/\/+$/, '');
  let wsUrl;
  try {
    const r = await fetch(base + '/json/version', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    wsUrl = (await r.json()).webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('没拿到 webSocketDebuggerUrl');
  } catch (e) {
    console.error('连不上浏览器的调试端口 ' + base + '(' + (e && e.message ? e.message : e) + ')。');
    console.error('浏览器要用 --remote-debugging-port 启动,端口和 --cdp 一致。');
    return 1;
  }

  let all;
  try {
    const j = await cdpCall(wsUrl, 1, 'Storage.getCookies', {});
    if (j.error) throw new Error(j.error.message || 'CDP 出错');
    all = (j.result && j.result.cookies) || [];
  } catch (e) {
    console.error('从浏览器读 cookie 没成(' + (e && e.message ? e.message : e) + ')。');
    return 1;
  }

  const cs = all.filter((c) => c && site.domain.test(String(c.domain || '')));
  const seen = new Map();
  for (const c of cs) {
    if (!seen.has(c.name) || String(c.domain).includes(site.prefer)) seen.set(c.name, c.value);
  }
  const names = [...seen.keys()];
  const keyCookies = cs.filter((c) => site.keys.includes(c.name));
  if (!site.keys.some((k) => seen.get(k))) {
    console.log('浏览器里没有' + site.label + '的登录(找不到 ' + site.keys.join(' / ') + '),没有覆盖原来的 cookie 文件。');
    console.log('请在这个浏览器里打开 ' + site.loginUrl + ' 登录,再跑一次。');
    return 2;
  }

  const str = [...seen].map(([k, v]) => k + '=' + v).join('; ');
  const exps = keyCookies.filter((c) => c.expires > 0).map((c) => Math.floor(c.expires));
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true, mode: 0o700 });
  writeAtomic(cookieFile, str);
  writeAtomic(metaFile, JSON.stringify({
    site: o.site,
    grabbed_at: Math.floor(Date.now() / 1000),
    key_expires: exps.length ? Math.min(...exps) : 0,
  }));

  console.log('已从浏览器取到' + site.label + '的 ' + names.length + ' 个 cookie(只列名字):' + names.join(', '));
  for (const c of keyCookies) {
    console.log('登录 key ' + c.name + '@' + c.domain + ' 到期:' + (c.expires > 0 ? new Date(c.expires * 1000).toISOString() : '浏览器关掉就失效(会话 cookie)'));
  }
  if (o.site === 'qq' && !names.includes('uin')) console.log('注意:没有 uin,读歌单可能不行。');
  console.log('已写入 ' + cookieFile + ' 和 meta.json');
  return 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(String(e && e.stack || e)); process.exitCode = 1; });
