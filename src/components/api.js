import fetch from "./interconnfetch";
import { appendLvglSuffix } from "./imageUrl";
import { safeJsonParse } from "./jsonUtils";

// Vela fetch 底层基于 curl，错误码直接透传 curl errno
export const FETCH_ERROR = {
  TIMEOUT: 28, // CURLE_OPERATION_TIMEDOUT 请求超时
  RESOLVE_HOST: 6, // CURLE_COULDNT_RESOLVE_HOST 域名解析失败
  SSL_PEER: 60, // CURLE_PEER_FAILED_VERIFICATION 证书校验失败
  SSL_CONNECT: 35, // CURLE_SSL_CONNECT_ERROR SSL 握手失败
  CONNECT_FAILED: 7, // CURLE_COULDNT_CONNECT 连接失败
  EMPTY_REPLY: 52, // CURLE_GOT_NOTHING 服务器空响应
};

// 常见 SSL/TLS 相关 curl errno（部分固件可能回落到这些码）
const SSL_CODES = {
  35: 1, // SSL connect error
  51: 1, // SSL peer certificate / SSH pubkey not OK
  53: 1, // SSL engine not found
  54: 1, // SSL engine set failed
  58: 1, // SSL local cert
  59: 1, // SSL engine init failed
  60: 1, // peer verification
  77: 1, // SSL CA cert
  80: 1, // SSL invalid CA
  82: 1, // SSL CRL bad
  83: 1, // SSL issuer error
  90: 1, // SSL pin mismatch
  91: 1, // SSL invalid certificate status
};

export function getFetchErrorType(code) {
  if (code === FETCH_ERROR.TIMEOUT) return "timeout";
  if (code === FETCH_ERROR.RESOLVE_HOST) return "domain";
  if (SSL_CODES[code]) return "ssl";
  if (code === FETCH_ERROR.CONNECT_FAILED || code === FETCH_ERROR.EMPTY_REPLY) return "connection";
  return "unknown";
}

// 综合 fail(data, code) 判类型：部分固件会把底层 curl 35 包成框架码（如 300），
// 但文案仍带 SSL/certificate；也从 "error code: 35" 里抠出真实 errno
export function classifyFetchError(data, code) {
  let raw = "";
  if (typeof data === "string") raw = data;
  else if (data && typeof data === "object") {
    raw = data.message || data.data || data.msg || "";
    if (!raw) {
      try {
        raw = JSON.stringify(data);
      } catch (e) {
        raw = "";
      }
    }
  }
  const msg = String(raw || "");
  let type = getFetchErrorType(code);
  if (type !== "ssl" && /ssl|tls|certificate|handshake/i.test(msg)) {
    type = "ssl";
  }
  // 文案里带 error code: N 时优先用真实 errno（日志里常见）
  let effectiveCode = code;
  const m = msg.match(/error\s*code\s*[:=]\s*(\d+)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n)) {
      effectiveCode = n;
      const t2 = getFetchErrorType(n);
      if (t2 !== "unknown") type = t2;
    }
  }
  // 底层 35/60 却被包成 300 等框架码时，仍按 SSL 处理
  if (type === "unknown" && (code === 300 || code === 0) && /ssl|certificate/i.test(msg)) {
    type = "ssl";
  }
  return { status: type, code: effectiveCode, message: msg };
}

export function getCurrentSource() {
  return global.API_SETTING[global.API_SETTING.using];
}

// 删除漫画源后校正当前使用的源：
// using 指向已删除的源时回退到第一个可用源；
// 若所有源都被删除（手机端可删内置源），恢复内置默认源兜底
export function ensureUsingSourceValid() {
  const setting = global.API_SETTING;
  if (setting[setting.using]) return;
  const keys = Object.keys(setting).filter((key) => key !== "using");
  if (keys.length > 0) {
    setting.using = keys[0];
    return;
  }
  const defaults = global.DEFAULT_API_SETTING || {};
  Object.keys(defaults).forEach((key) => {
    setting[key] = defaults[key];
  });
  setting.using = Object.keys(defaults)[0] || "";
}

// 源配置数组按 key 合并去重：同 key 原位替换，新 key 追加（sources.json 落盘结构，
// 数组元素为单键对象）；支持一次传入多 key 对象（edit 页远端 config 原文）
export function replaceIfDuplicate(configArray, newConfigObject) {
  const keys = Object.keys(newConfigObject);

  keys.forEach((newKey) => {
    const singleConfig = { [newKey]: newConfigObject[newKey] };
    let found = false;

    for (let i = 0; i < configArray.length; i++) {
      const existingConfig = configArray[i];
      const existingKey = Object.keys(existingConfig)[0];

      if (existingKey === newKey) {
        configArray[i] = singleConfig;
        found = true;
        break;
      }
    }

    if (!found) {
      configArray.push(singleConfig);
    }
  });

  return configArray;
}

// 源配置数组（单键对象列表）合并进 global.API_SETTING，同步内存真相
// 脏数据防御（P0-12）：非对象元素/空对象/值非对象一律跳过——sources.json 被写坏
// （如 [null, {...}]）时 Object.keys(null) 抛 TypeError 会让 bootstrap 链中断、
// 启动页永久"加载中"，故逐元素校验
export function mergeSourcesToGlobal(sourceArray) {
  sourceArray.forEach((newSourceConfig) => {
    if (!newSourceConfig || typeof newSourceConfig !== "object") return;
    const newKey = Object.keys(newSourceConfig)[0];
    if (!newKey) return;
    const value = newSourceConfig[newKey];
    if (!value || typeof value !== "object") return;
    global.API_SETTING[newKey] = value;
  });
}

export function buildHeaders(extra) {
  return {
    "User-Agent": global.userAgent(),
    ...(global.cookie && global.cookie[global.API_SETTING.using]
      ? { Cookie: global.cookie[global.API_SETTING.using] }
      : {}),
    ...(extra || {}),
  };
}

export function buildSourceUrl(path, replacements) {
  let url = getCurrentSource().apiUrl + path;
  const map = replacements || {};
  Object.keys(map).forEach((key) => {
    // String.replace 字符串模式只替换首个匹配，split/join 全量替换（同一 key 出现多次时）
    url = url.split("<" + key + ">").join(map[key]);
  });
  return url;
}

export function buildDetailUrl(id) {
  return buildSourceUrl(getCurrentSource().detailPath, { id: id });
}

export function buildPhotoUrl(id, chapter) {
  return buildSourceUrl(getCurrentSource().photoPath, {
    id: id,
    chapter: chapter,
  });
}

export function buildSearchUrl(text, page) {
  return buildSourceUrl(getCurrentSource().searchPath, {
    text: encodeURIComponent(text),
    page: page || "1",
  });
}

export function apiFetch(options) {
  return fetch.fetch({
    ...options,
    header: buildHeaders(options.header),
  });
}

// 探测源 /config 是否可用（OOBE 快速检查 / 全源检测共用）
// status: ok | missing | ssl | timeout | domain | connection | http | invalid | unknown
export function checkSourceHealth(sourceKey) {
  const source = global.API_SETTING[sourceKey];
  const name = (source && source.name) || sourceKey;
  const apiUrl = (source && source.apiUrl) || "";
  if (!source || !source.apiUrl) {
    return Promise.resolve({ status: "missing", key: sourceKey, name: name, apiUrl: apiUrl });
  }
  return new Promise((resolve) => {
    apiFetch({
      url: source.apiUrl + "/config",
      responseType: "text",
      success: (response) => {
        const statusCode = response.statusCode || 200;
        if (statusCode >= 400) {
          resolve({ status: "http", code: statusCode, key: sourceKey, name: name, apiUrl: apiUrl });
          return;
        }
        const data = safeJsonParse(response.data, null);
        if (data == null || typeof data !== "object" || Array.isArray(data)) {
          resolve({ status: "invalid", key: sourceKey, name: name, apiUrl: apiUrl });
          return;
        }
        resolve({ status: "ok", key: sourceKey, name: name, apiUrl: apiUrl });
      },
      fail: (data, code) => {
        const classified = classifyFetchError(data, code);
        resolve({
          status: classified.status || "unknown",
          code: classified.code,
          key: sourceKey,
          name: name,
          apiUrl: apiUrl,
          data: classified.message || data,
        });
      },
    });
  });
}

// 设备不支持直接加载远程图片时，通过插件把图片拉取为本地文件后回调本地 uri；
// 支持直连的设备直接回调原 url
// priority 透传给请求队列：0 = 用户可见（默认），1 = 后台（预加载/封面）
export function proxyImage(url, name, callback, priority) {
  fetch.isDirectAvailable().then((direct) => {
    if (direct) {
      callback(url);
      return;
    }
    apiFetch({
      url: appendLvglSuffix(url, name),
      responseType: "file",
      priority: priority || 0,
      success: (response) => {
        callback(response.data || "");
      },
      fail: () => {
        callback("");
      },
    });
  });
}
