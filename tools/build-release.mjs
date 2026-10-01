#!/usr/bin/env node
// 构建包装脚本：在打包前把 src/i18n/*.json 临时压缩为无空白单行，打包完成后无论成功失败均恢复原样，
// 实现“源码保持友好缩进阅读，发布产物独享体积最小化”。
// 用法：node tools/build-release.mjs [args...]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(import.meta.dirname, "..");
const i18nDir = path.join(rootDir, "src", "i18n");

const jsonFiles = fs
  .readdirSync(i18nDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => path.join(i18nDir, f));

const backups = new Map();
for (const file of jsonFiles) {
  backups.set(file, fs.readFileSync(file, "utf8"));
}

function restore() {
  for (const [file, original] of backups.entries()) {
    try {
      fs.writeFileSync(file, original, "utf8");
    } catch (_) {}
  }
}

// 确保无论发生异常还是收到中断信号都能恢复源文件
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});
process.on("uncaughtException", (err) => {
  restore();
  console.error(err);
  process.exit(1);
});

try {
  // 临时压缩为单行
  for (const file of jsonFiles) {
    const raw = backups.get(file);
    const minified = JSON.stringify(JSON.parse(raw));
    fs.writeFileSync(file, minified, "utf8");
  }

  // 运行原生 aiot release
  const userArgs = process.argv.slice(2);
  const args = userArgs.length > 0 ? userArgs : ["--enable-jsc"];
  const aiotBin = path.join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "aiot.cmd" : "aiot"
  );
  const result = spawnSync(aiotBin, ["release", ...args], {
    cwd: rootDir,
    stdio: "inherit",
    shell: true,
  });

  restore();
  process.exit(result.status ?? 0);
} catch (error) {
  restore();
  console.error("构建失败:", error);
  process.exit(1);
}
