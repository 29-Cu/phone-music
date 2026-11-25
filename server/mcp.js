#!/usr/bin/env node
"use strict";

// MCP(stdio)入口:让 Claude Code / Claude Desktop / 任何支持 MCP 的客户端把 phone_music 挂成一个工具。
// 它自己不存状态,只把调用转给正在跑的 phone-music 服务器(电话状态在那边)。零依赖,手写最小的 MCP:
//   initialize / tools/list / tools/call / ping
// 环境变量:PHONE_MUSIC_URL(默认 http://127.0.0.1:3480)、PHONE_MUSIC_TOKEN(不给就读 data/token.txt)
//
// 配置例(Claude Code):claude mcp add phone-music -- node /path/to/phone-music/server/mcp.js

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const BASE = (process.env.PHONE_MUSIC_URL || "http://127.0.0.1:3480").replace(/\/+$/, "");
function token() {
  if (process.env.PHONE_MUSIC_TOKEN) return process.env.PHONE_MUSIC_TOKEN;
  const dir = process.env.PHONE_MUSIC_DATA || path.join(__dirname, "..", "data");
  try { return fs.readFileSync(path.join(dir, "token.txt"), "utf8").trim(); } catch (e) { return ""; }
}

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
  return j;
}

// 服务器没开的时候也要能列出工具(不然客户端会以为这个 MCP 坏了)
const FALLBACK = { name: "phone_music", description: "电话里放歌(phone-music 服务器现在连不上,先把它跑起来)。", input_schema: { type: "object", properties: { action: { type: "string" } } } };

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function onMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "phone-music", version: require("../package.json").version },
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      let def = FALLBACK;
      try { def = await call("GET", "/api/tool"); } catch (e) {}
      return reply(id, { tools: [{ name: def.name, title: "电话里放歌", description: def.description, inputSchema: def.input_schema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }] });
    }
    if (method === "tools/call") {
      if (!params || params.name !== "phone_music") return error(id, -32602, "没有这个工具: " + (params && params.name));
      let text;
      try { text = (await call("POST", "/api/tool", params.arguments || {})).text; }
      catch (e) { return reply(id, { content: [{ type: "text", text: "phone-music 服务器连不上:" + e.message }], isError: true }); }
      return reply(id, { content: [{ type: "text", text }] });
    }
    if (isRequest) return error(id, -32601, "不认识的方法: " + method);
    // 通知(notifications/initialized 之类):不用回
  } catch (e) {
    if (isRequest) error(id, -32603, String(e && e.message || e));
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { return error(null, -32700, "不是 JSON"); }
  if (Array.isArray(msg)) msg.forEach(onMessage); else onMessage(msg);
});
