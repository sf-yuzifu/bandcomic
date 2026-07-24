#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

function findUxServer() {
  const extDirs = [
    ".aiot-ide/extensions",
    ".vscode/extensions",
    ".vscode-insiders/extensions",
    ".cursor/extensions",
    ".trae/extensions",
    ".trae-cn/extensions",
    ".windsurf/extensions",
  ];
  const candidates = [];
  for (const dir of extDirs) {
    const base = path.join(os.homedir(), dir);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const m = entry.match(/^vela\.aiot-ux-(\d+\.\d+\.\d+)$/);
      if (!m) continue;
      const server = path.join(base, entry, "dist", "server.js");
      if (fs.existsSync(server)) candidates.push({ version: m[1], server });
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return candidates[0]?.server || null;
}

function collectUxFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectUxFiles(p));
    else if (entry.name.endsWith(".ux")) out.push(p);
  }
  return out;
}

function createLspClient(proc) {
  let buf = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const m = buf.slice(0, headerEnd).toString().match(/Content-Length: (\d+)/i);
      if (!m) throw new Error("invalid LSP header");
      const len = parseInt(m[1], 10);
      if (buf.length < headerEnd + 4 + len) return;
      const msg = JSON.parse(buf.slice(headerEnd + 4, headerEnd + 4 + len).toString());
      buf = buf.slice(headerEnd + 4 + len);
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      }
    }
  });

  return function send(method, params, isNotify = false) {
    const msg = { jsonrpc: "2.0", method, params };
    if (!isNotify) msg.id = nextId++;
    const body = JSON.stringify(msg);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    if (isNotify) return Promise.resolve();
    return new Promise((resolve, reject) => pending.set(msg.id, { resolve, reject }));
  };
}

function applyEdits(text, edits) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  const toOffset = (pos) => offsets[pos.line] + pos.character;
  let out = text;
  const sorted = [...edits].sort((a, b) => toOffset(b.range.start) - toOffset(a.range.start));
  for (const e of sorted) {
    out = out.slice(0, toOffset(e.range.start)) + e.newText + out.slice(toOffset(e.range.end));
  }
  return out;
}

const serverPath = process.env.UX_LS_PATH || findUxServer();
if (!serverPath) {
  console.error("未找到 vela.aiot-ux 扩展的语言服务器，请先在 AIoT IDE / VSCode 中安装 aiot-ux 扩展，");
  console.error("或设置 UX_LS_PATH 环境变量指向其 dist/server.js");
  process.exit(1);
}

const tsdk = path.join(rootDir, "node_modules/typescript/lib");
if (!fs.existsSync(path.join(tsdk, "typescript.js"))) {
  console.error("未找到 typescript 库，请先执行 yarn install");
  process.exit(1);
}

const files = process.argv.slice(2).map((f) => path.resolve(f));
const targets = files.length ? files : collectUxFiles(path.join(rootDir, "src"));
if (!targets.length) {
  console.log("没有需要格式化的 .ux 文件");
  process.exit(0);
}

console.log(`使用语言服务器: ${serverPath}`);
const proc = spawn(process.execPath, [serverPath, "--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const send = createLspClient(proc);

const rootUri = "file://" + rootDir;
await send("initialize", {
  processId: process.pid,
  rootUri,
  initializationOptions: {
    typescript: { tsdk },
    uxLib: path.join(path.dirname(serverPath), "types", "lib.d.ts"),
  },
  capabilities: { textDocument: { formatting: { dynamicRegistration: false } } },
  workspaceFolders: [{ uri: rootUri, name: path.basename(rootDir) }],
});
await send("initialized", {}, true);

let changed = 0;
for (const file of targets) {
  const uri = "file://" + file;
  const text = fs.readFileSync(file, "utf8");
  await send(
    "textDocument/didOpen",
    { textDocument: { uri, languageId: "ux", version: 1, text } },
    true
  );
  try {
    const edits = await send("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    if (edits && edits.length) {
      const formatted = applyEdits(text, edits);
      if (formatted !== text) {
        fs.writeFileSync(file, formatted);
        changed++;
        console.log(`formatted: ${path.relative(rootDir, file)}`);
      }
    }
  } catch (e) {
    console.error(`格式化失败 ${path.relative(rootDir, file)}: ${e.message}`);
  }
  await send("textDocument/didClose", { textDocument: { uri } }, true);
}

await send("shutdown");
await send("exit", {}, true);
proc.kill();
console.log(`完成，共 ${targets.length} 个文件，${changed} 个有改动`);
