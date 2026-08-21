#!/usr/bin/env node
// PNG 压缩工具：pngquant（有损量化重编码，抖动/无抖动两路）+ oxipng（无损再压缩）三候选，
// 取体积最小者，体积差距 ≤2% 时优先保真度更高的路径；仅在严格小于原文件时覆盖。
// 原文件均在 git 跟踪下，如效果不满意可用 git checkout 还原。
// 用法：node tools/compress-png.mjs [--colors=256] [--quality=70] [--dir=src/common] [--dry-run] [--force]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { oxipngSync } from "oxipng";
import pngquant from "pngquant-bin";

const rootDir = path.resolve(import.meta.dirname, "..");

const opt = { colors: 256, quality: 70, dryRun: false, force: false, dir: path.join(rootDir, "src/common") };
for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") opt.dryRun = true;
  else if (arg === "--force") opt.force = true;
  else if (arg.startsWith("--colors=")) opt.colors = parseInt(arg.slice("--colors=".length), 10);
  else if (arg.startsWith("--quality=")) opt.quality = parseInt(arg.slice("--quality=".length), 10);
  else if (arg.startsWith("--dir=")) opt.dir = path.resolve(arg.slice("--dir=".length));
  else {
    console.error(`未知参数: ${arg}`);
    process.exit(1);
  }
}
if (!Number.isInteger(opt.colors) || opt.colors < 2 || opt.colors > 256) {
  console.error(`--colors 必须是 2~256 的整数，收到: ${opt.colors}`);
  process.exit(1);
}
if (!Number.isInteger(opt.quality) || opt.quality < 0 || opt.quality > 100) {
  console.error(`--quality 必须是 0~100 的整数（量化质量下限，低于则放弃有损路径），收到: ${opt.quality}`);
  process.exit(1);
}
if (!fs.existsSync(opt.dir)) {
  console.error(`目录不存在: ${opt.dir}`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compress-png-"));

// oxipng 无损再压缩：原地优化临时文件后读回
function oxipngRecompress(buf, tmpFile) {
  fs.writeFileSync(tmpFile, buf);
  oxipngSync(["-o", "6", "--strip", "all", "--alpha", tmpFile], { stdio: "pipe" });
  return fs.readFileSync(tmpFile);
}

// pngquant 量化：stdin 喂入、stdout 产出；质量低于下限会以非 0 退出码拒绝
// 注意：颜色数为位置参数 ncolors（pngquant 2.17 Rust 版无 --colors 选项）
function pngquantQuantize(buf, noDither) {
  const args = [
    "--force",
    "--output", "-",
    "--quality", `${opt.quality}-100`,
    "--speed", "1",
    "--strip",
  ];
  if (noDither) args.push("--nofs");
  args.push(String(opt.colors), "-");
  const r = spawnSync(pngquant, args, { input: buf, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout;
}

function formatKB(bytes) {
  return (bytes / 1024).toFixed(1) + "K";
}

const files = fs
  .readdirSync(opt.dir)
  .filter((f) => f.toLowerCase().endsWith(".png"))
  .sort();
if (!files.length) {
  console.log(`目录下没有 PNG 文件: ${opt.dir}`);
  process.exit(0);
}

console.log(
  `${opt.dryRun ? "[dry-run] " : ""}压缩目录: ${path.relative(rootDir, opt.dir)}，` +
    `量化: ≤${opt.colors} 色/质量下限 ${opt.quality}，无损再压: oxipng -o6`
);

let totalBefore = 0;
let totalAfter = 0;
let changed = 0;
let skipped = 0;
let failed = 0;

try {
  for (const name of files) {
    const file = path.join(opt.dir, name);
    const before = fs.readFileSync(file);
    totalBefore += before.length;
    try {
      const tmpFile = path.join(tmpDir, name);
      // fidelity 越小保真度越高：无损 > 量化+抖动 > 量化无抖动
      const candidates = [{ kind: "无损", fidelity: 0, buf: oxipngRecompress(before, tmpFile) }];
      const dithered = pngquantQuantize(before, false);
      if (dithered) {
        candidates.push({ kind: "量化", fidelity: 1, buf: oxipngRecompress(dithered, tmpFile) });
      }
      const noDither = pngquantQuantize(before, true);
      if (noDither) {
        candidates.push({ kind: "量化无抖动", fidelity: 2, buf: oxipngRecompress(noDither, tmpFile) });
      }
      candidates.sort((a, b) => a.buf.length - b.buf.length);
      let best = candidates[0];
      // 体积差距 ≤2% 时回退到保真度更高的候选，不为了零头损失画质
      for (const c of candidates.slice(1)) {
        if (c.fidelity < best.fidelity && c.buf.length <= best.buf.length * 1.02) best = c;
      }
      if (best.buf.length >= before.length && !opt.force) {
        skipped++;
        totalAfter += before.length;
        console.log(`  跳过（无收益）: ${name} ${formatKB(before.length)} → ${formatKB(best.buf.length)}`);
        continue;
      }
      totalAfter += best.buf.length;
      if (!opt.dryRun) fs.writeFileSync(file, best.buf);
      changed++;
      const ratio = ((1 - best.buf.length / before.length) * 100).toFixed(0);
      console.log(`  ${name}: ${formatKB(before.length)} → ${formatKB(best.buf.length)}（-${ratio}%，${best.kind}）`);
    } catch (e) {
      console.error(`  失败: ${name}: ${e.message}`);
      failed++;
      totalAfter += before.length;
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(
  `完成：${changed} 个已压缩，${skipped} 个无收益跳过，${failed} 个失败；` +
    `总体积 ${formatKB(totalBefore)} → ${formatKB(totalAfter)}` +
    `（-${((1 - totalAfter / totalBefore) * 100).toFixed(0)}%）`
);
if (failed > 0) process.exit(1);
