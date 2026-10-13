import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 复用设备端的源校验器。项目是 CommonJS，设备模块是 ESM；通过 data URL
// 加载这个无依赖模块，兼容 Node 20，避免维护两份接口校验规则。
const validatorSource = fs.readFileSync(path.join(rootDir, "src/components/sourceConfig.js"), "utf8");
const { validateSourceConfig } = await import(
  "data:text/javascript;base64," + Buffer.from(validatorSource).toString("base64")
);

export function parseBuildOptions(args) {
  const options = { builtinSources: false, onlineUpdate: false, aiotArgs: [] };
  const flags = {
    "--with-builtin-sources": ["builtinSources", true],
    "--without-builtin-sources": ["builtinSources", false],
    "--with-online-update": ["onlineUpdate", true],
    "--without-online-update": ["onlineUpdate", false],
  };
  const seen = new Map();
  for (const arg of args) {
    const flag = flags[arg];
    if (!flag) {
      if (/^--(?:with|without)-(?:builtin|online)/.test(arg)) {
        throw new Error("未知私有配置开关：" + arg);
      }
      options.aiotArgs.push(arg);
      continue;
    }
    const [key, value] = flag;
    if (seen.has(key) && seen.get(key) !== value) {
      throw new Error("不能同时开启和关闭同一功能：" + key);
    }
    seen.set(key, value);
    options[key] = value;
  }
  return options;
}

export function loadBuildConfig(options, configFile = path.join(rootDir, "private.config.json")) {
  const config = { sources: {}, defaultSource: "", updateCheckUrl: "" };
  // 默认构建连私有文件都不读取，配置存在、缺失或损坏均不影响公开版本。
  if (!options.builtinSources && !options.onlineUpdate) return config;

  let privateConfig;
  try {
    privateConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (_) {
    // 不转发 JSON 解析错误，避免错误日志包含真实地址。
    throw new Error("无法读取 private.config.json，请复制模板并填写本次开启功能的配置");
  }
  if (!privateConfig || typeof privateConfig !== "object" || Array.isArray(privateConfig)) {
    throw new Error("private.config.json 必须是 JSON 对象");
  }
  if (options.builtinSources) {
    const sources = privateConfig.sources;
    if (!sources || typeof sources !== "object" || Array.isArray(sources) || !Object.keys(sources).length) {
      throw new Error("已开启内置源，但 private.config.json 的 sources 为空或无效");
    }
    for (const key of Object.keys(sources)) {
      const error = validateSourceConfig(key, sources[key]);
      if (error) throw new Error("内置源配置无效，字段：" + error);
      config.sources[key] = { ...sources[key], apiUrl: sources[key].apiUrl.replace(/\/+$/, "") };
    }
    config.defaultSource = privateConfig.defaultSource || Object.keys(config.sources)[0];
    if (!Object.hasOwn(config.sources, config.defaultSource)) {
      throw new Error("defaultSource 必须指向 sources 中的有效源");
    }
  }
  if (options.onlineUpdate) {
    const url = privateConfig.updateCheckUrl;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || /[\s<>]/.test(url)) {
      throw new Error("已开启在线更新，但 updateCheckUrl 不是有效 HTTP/HTTPS 地址");
    }
    try {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error();
    } catch (_) {
      throw new Error("updateCheckUrl 不是有效更新检查地址");
    }
    config.updateCheckUrl = url;
  }
  return config;
}
