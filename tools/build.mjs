#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { rootDir, parseBuildOptions, loadBuildConfig } from "./build-config.mjs";

export function runBuild(command, args) {
  if (!["start", "build", "release"].includes(command)) {
    throw new Error("构建命令必须是 start、build 或 release");
  }
  const options = parseBuildOptions(args);
  const config = loadBuildConfig(options);
  const backups = new Map();
  const restore = () => {
    const errors = [];
    for (const [file, original] of backups) {
      let lastError;
      // Windows 上 toolkit 迁移临时项目后，文件可能仍被索引器短暂占用。
      // 每个文件独立重试；一个文件失败也不能阻止其他源码恢复。
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          fs.writeFileSync(file, original);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
      if (lastError) errors.push(lastError);
    }
    if (errors.length) throw new AggregateError(errors, "未能恢复 i18n 源文件，请检查文件占用");
  };
  const interrupt = () => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    // 仅发布构建临时压缩 i18n；任何成功/失败路径都会恢复源码。
    if (command === "release") {
      const i18nDir = path.join(rootDir, "src/i18n");
      for (const name of fs.readdirSync(i18nDir).filter((name) => name.endsWith(".json"))) {
        const file = path.join(i18nDir, name);
        const original = fs.readFileSync(file);
        backups.set(file, original);
        fs.writeFileSync(file, JSON.stringify(JSON.parse(original.toString("utf8"))));
      }
      if (!options.aiotArgs.some((arg) => arg === "--enable-jsc" || arg.startsWith("--enable-jsc="))) {
        options.aiotArgs.push("--enable-jsc");
      }
    }
    console.info("构建配置：内置源=" + options.builtinSources + "，在线更新=" + options.onlineUpdate);
    // 直接启动 toolkit 的 Node CLI，避免 Windows .cmd / shell 转义及参数注入。
    const result = spawnSync(process.execPath, [
      path.join(rootDir, "node_modules/aiot-toolkit/lib/bin.js"), command, ...options.aiotArgs,
    ], {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, BANDCOMIC_BUILD_CONFIG: JSON.stringify(config) },
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    restore();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runBuild(process.argv[2], process.argv.slice(3));
  } catch (error) {
    console.error("构建失败：", error.message);
    process.exitCode = 1;
  }
}
