import fetch from "./interconnfetch";
import { appendCoverSuffix } from "./imageUrl";
import { safeJsonParse } from "./jsonUtils";
import { getHttpStatus, isHttpSuccess, createHttpError } from "./httpResponse";
import { validateSourceConfig, validSourceDirectory } from "./sourceConfig";
import { deleteImageTemp } from "./imageFile";
export { validateSourceConfig, validSourceDirectory, isComicId } from "./sourceConfig";

export { getHttpStatus, isHttpSuccess } from "./httpResponse";

export function isComicDetailResponse(response) {
  if (!isHttpSuccess(response)) return false;
  const body = response.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const id = body.item_id;
  const validId = (typeof id === "string" && id.trim().length > 0) ||
    (typeof id === "number" && Number.isFinite(id) && id >= 0);
  const pages = body.page_count;
  const validPages = (typeof pages === "number" || (typeof pages === "string" && pages.trim() !== "")) &&
    Number.isInteger(Number(pages)) && Number(pages) >= 0;
  return validId && typeof body.name === "string" && body.name.trim().length > 0 && validPages;
}

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

export const DEFAULT_HTTP_STATUS_DESC = {
  400: "Invalid parameters",
  401: "Authentication required",
  403: "Access denied (cookie/purchase/region)",
  404: "Comic or chapter not found",
  408: "Request timeout",
  409: "State conflict (cursor expired)",
  413: "Payload too large",
  429: "Rate limited by source",
  500: "Internal server error",
  502: "Upstream station error or parse failure",
  503: "Service busy (queue full)",
  504: "Gateway timeout",
};

export const DEFAULT_CURL_ERROR_DESC = {
  6: "DNS resolution failed",
  7: "Connection refused",
  28: "Network request timeout (curl 28)",
  35: "SSL handshake failed (try bridge)",
  52: "Server returned empty reply (curl 52)",
  60: "SSL certificate verification failed (curl 60)",
};

function resolveHttpDesc(statusCode, t) {
  if (typeof t === "function") {
    const key = `error.http.${statusCode}`;
    const localized = t(key);
    if (localized && localized !== key) return localized;
  }
  return DEFAULT_HTTP_STATUS_DESC[statusCode] || `HTTP ${statusCode}`;
}

function resolveCurlDesc(curlCode, errorType, t) {
  if (typeof t === "function") {
    if (curlCode) {
      const key = `error.curl.${curlCode}`;
      const localized = t(key);
      if (localized && localized !== key) return localized;
    }
    if (errorType && errorType !== "unknown") {
      const key = `error.${errorType}`;
      const localized = t(key);
      if (localized && localized !== key) return localized;
    }
  }
  return DEFAULT_CURL_ERROR_DESC[curlCode] || (typeof t === "function" ? t("error.networkError") : "Network error");
}

export function formatApiError(data, code, options = {}) {
  const t = typeof options.t === "function" ? options.t : null;
  const sourceKey = options.sourceKey || (global.API_SETTING && global.API_SETTING.using) || "";
  const sourceConfig = (sourceKey && global.API_SETTING && global.API_SETTING[sourceKey]) || null;
  const sourceName = (sourceConfig && sourceConfig.name) || sourceKey || "";
  const sourceTag = sourceName ? `[${sourceName}] ` : "";
  const actionPrefix = options.action ? `${options.action} ` : "";

  let rawMsg = "";
  let statusCode = null;
  let retryAfter = null;

  let parsed = null;
  if (data && typeof data === "object") {
    parsed = data;
  } else if (typeof data === "string") {
    rawMsg = data.trim();
    if (rawMsg.startsWith("{") && rawMsg.endsWith("}")) {
      try {
        parsed = JSON.parse(rawMsg);
      } catch (_) {}
    }
  }

  if (parsed && typeof parsed === "object") {
    if (parsed.message) rawMsg = String(parsed.message);
    else if (parsed.msg) rawMsg = String(parsed.msg);
    else if (parsed.error) rawMsg = String(parsed.error);
    if (parsed.code && Number.isInteger(Number(parsed.code))) {
      statusCode = Number(parsed.code);
    }
    if (parsed.retryAfter || parsed.retry_after) {
      retryAfter = Number(parsed.retryAfter || parsed.retry_after);
    }
  }

  const numericCode = Number(code);
  if (Number.isInteger(numericCode) && numericCode >= 100 && numericCode <= 599) {
    statusCode = numericCode;
  }

  if (!statusCode && rawMsg) {
    const httpMatch = rawMsg.match(/HTTP\s*(\d{3})/i);
    if (httpMatch) {
      statusCode = Number(httpMatch[1]);
    }
  }
  if (!retryAfter && rawMsg) {
    const retryMatch = rawMsg.match(/Retry-After\s*(\d+)s?/i);
    if (retryMatch) {
      retryAfter = Number(retryMatch[1]);
    }
  }

  const classified = classifyFetchError(data, code);
  const curlCode = (classified && classified.code) || code;
  const errorType = (classified && classified.status) || "unknown";

  if (statusCode) {
    const statusText = resolveHttpDesc(statusCode, t);
    const isGenericHttp = /^HTTP\s*\d{3}(?:\s*\(.*\))?$/i.test(rawMsg);
    let detailDesc = (rawMsg && !isGenericHttp && rawMsg !== "Upstream failed" && rawMsg !== "请求失败")
      ? rawMsg
      : statusText;
    if (retryAfter && !detailDesc.includes("Retry-After")) {
      const retrySuffix = t ? t("error.retryAfter", { seconds: retryAfter }) : ` (wait ${retryAfter}s)`;
      detailDesc += retrySuffix;
    }
    return {
      sourceKey,
      sourceName,
      statusCode,
      curlCode: null,
      type: "http",
      message: detailDesc,
      formatted: `${sourceTag}${actionPrefix}[${statusCode}] ${detailDesc}`,
    };
  }

  const desc = resolveCurlDesc(curlCode, errorType, t);
  const isGenericCurlMsg = /timed?\s*out|resolve\s*host|connection\s*refused|ssl|handshake|empty\s*reply/i.test(rawMsg);
  const isCustomRaw = rawMsg && rawMsg !== "unknown" && !rawMsg.startsWith("error code:") && !isGenericCurlMsg;
  const finalDesc = isCustomRaw ? rawMsg : desc;
  return {
    sourceKey,
    sourceName,
    statusCode: null,
    curlCode: curlCode || null,
    type: errorType,
    message: finalDesc,
    formatted: `${sourceTag}${actionPrefix}${finalDesc}`,
  };
}

export function getCurrentSource() {
  return global.API_SETTING[global.API_SETTING.using];
}

// 当前源显示名：using 悬空（源被删等）时回退空串（P0-11 防御），不再解引用崩溃
export function getCurrentSourceName() {
  const source = getCurrentSource();
  return (source && source.name) || "";
}

// 删除漫画源后校正当前使用的源：
// using 指向已删除的源时回退到第一个可用源；
// 若所有源都被删除（手机端可删内置源），恢复内置默认源兜底
export function ensureUsingSourceValid() {
  const setting = global.API_SETTING;
  // using === "using" 自指时 setting[setting.using] 恒真，必须显式排除（P2-35①）
  if (setting.using !== "using" && setting[setting.using]) return;
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
  newConfigObject = validSourceDirectory(newConfigObject);
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
    // "using" 是指针槽位的保留键（API_SETTING 内与源同级，各列表页均已过滤），
    // 脏条目合并会覆盖指针致悬空（P2-35①）
    if (newKey === "using") return;
    const value = newSourceConfig[newKey];
    if (validateSourceConfig(newKey, value)) return;
    global.API_SETTING[newKey] = value;
  });
}

export function buildHeaders(extra, sourceKey) {
  const targetKey =
    sourceKey !== undefined ? sourceKey : global.API_SETTING && global.API_SETTING.using;
  return {
    "User-Agent": global.userAgent(),
    ...(global.cookie && targetKey && global.cookie[targetKey]
      ? { Cookie: global.cookie[targetKey] }
      : {}),
    ...(extra || {}),
  };
}

export function buildSourceUrl(path, replacements, source = getCurrentSource()) {
  let url = source.apiUrl + path;
  const map = replacements || {};
  Object.keys(map).forEach((key) => {
    // String.replace 字符串模式只替换首个匹配，split/join 全量替换（同一 key 出现多次时）
    url = url.split("<" + key + ">").join(map[key]);
  });
  return url;
}

// Credentials stay in memory; router parameters contain only an opaque token.
const contexts = {};
let contextSequence = 0;
export function captureSource(sourceKey) {
  const key = sourceKey || global.API_SETTING.using;
  const source = global.API_SETTING[key];
  if (!source || validateSourceConfig(key, source)) throw new Error("Invalid source configuration");
  return { key: key, source: { ...source }, header: buildHeaders({}, key) };
}
export function saveSourceContext(context) {
  const token = "source_" + Date.now() + "_" + (++contextSequence);
  contexts[token] = { context: context, expires: Date.now() + 3600000 };
  Object.keys(contexts).forEach((key) => { if (contexts[key].expires < Date.now()) delete contexts[key]; });
  const keys = Object.keys(contexts);
  while (keys.length > 24) delete contexts[keys.shift()];
  return token;
}
export function getSourceContext(token, sourceKey) {
  const saved = token && contexts[token];
  if (saved && saved.expires > Date.now()) return saved.context;
  if (token) throw new Error("Source context expired; reopen the comic");
  return captureSource(sourceKey);
}

export function buildDetailUrl(id, source = getCurrentSource()) {
  return buildSourceUrl(source.detailPath, { id: encodeURIComponent(id) }, source);
}

export function buildPhotoUrl(id, chapter, source = getCurrentSource()) {
  return buildSourceUrl(source.photoPath, {
    id: encodeURIComponent(id),
    chapter: encodeURIComponent(chapter),
  }, source);
}

export function buildSearchUrl(text, page, source = getCurrentSource()) {
  return buildSourceUrl(source.searchPath, {
    text: encodeURIComponent(text),
    page: page || "1",
  }, source);
}

const sourceCooldown = {};
export function apiFetch(options) {
  const key = options.anonymous ? "" : options.sourceContext ? options.sourceContext.key : options.sourceKey || global.API_SETTING.using;
  const cooldown = key && sourceCooldown[key];
  if (cooldown && cooldown.until > Date.now()) {
    const timer = setTimeout(() => {
      if (options.fail) options.fail(cooldown.error.message, cooldown.error.code);
      if (options.complete) options.complete();
    }, 0);
    return { cancel: () => clearTimeout(timer) };
  }
  return fetch.fetch({
    ...options,
    header: options.anonymous ? { "User-Agent": global.userAgent(), ...(options.header || {}) } :
      options.sourceContext ? { ...options.sourceContext.header, ...(options.header || {}) } : buildHeaders(options.header, options.sourceKey),
    success: (response) => {
      if (!isHttpSuccess(response)) {
        if (options.responseType === "file") deleteImageTemp(response.data);
        const error = createHttpError(response);
        if (key && [429, 503].indexOf(error.code) !== -1) {
          sourceCooldown[key] = { until: Date.now() + (error.retryAfter || 2) * 1000, error: error };
        }
        if (options.fail) options.fail(error.message, error.code);
        return;
      }
      if (options.success) options.success(response);
    },
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
      sourceKey: sourceKey,
      anonymous: true,
      success: (response) => {
        const statusCode = getHttpStatus(response);
        if (!isHttpSuccess(response)) {
          resolve({ status: "http", code: statusCode, key: sourceKey, name: name, apiUrl: apiUrl });
          return;
        }
        const data = safeJsonParse(response.data, null);
        if (!data || validateSourceConfig(sourceKey, data[sourceKey])) {
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
// priority 透传给请求队列：0 = 用户可见（默认），1 = 后台封面
export function proxyImage(url, name, callback, priority, sourceKey, sourceContext) {
  const snapshot = sourceContext || captureSource(sourceKey);
  fetch.isDirectAvailable().then((direct) => {
    if (direct && !snapshot.header.Cookie) {
      callback(url);
      return;
    }
    apiFetch({
      url: appendCoverSuffix(url, name),
      responseType: "file",
      priority: priority || 0,
      sourceKey: sourceKey,
      sourceContext: snapshot,
      success: (response) => {
        callback(response.data || "");
      },
      fail: () => {
        callback("");
      },
    });
  });
}
