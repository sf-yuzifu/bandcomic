#!/usr/bin/env node
// 保留原发布入口；与 start/build 共用私有配置开关和 i18n 恢复逻辑。
import process from "node:process";
import { runBuild } from "./build.mjs";

try {
  process.exitCode = runBuild("release", process.argv.slice(2));
} catch (error) {
  console.error("构建失败：", error.message);
  process.exitCode = 1;
}
