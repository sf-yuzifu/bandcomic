import fetch from "./interconnfetch";
import { appendLvglSuffix } from "./imageUrl";

// Vela fetch 底层基于 curl，错误码直接透传 curl errno
export const FETCH_ERROR = {
  TIMEOUT: 28, // CURLE_OPERATION_TIMEDOUT 请求超时
  RESOLVE_HOST: 6, // CURLE_COULDNT_RESOLVE_HOST 域名解析失败
  SSL_PEER: 60, // CURLE_PEER_FAILED_VERIFICATION 证书校验失败
  SSL_CONNECT: 35, // CURLE_SSL_CONNECT_ERROR SSL 握手失败
  CONNECT_FAILED: 7, // CURLE_COULDNT_CONNECT 连接失败
  EMPTY_REPLY: 52, // CURLE_GOT_NOTHING 服务器空响应
};

export function getFetchErrorType(code) {
  if (code === FETCH_ERROR.TIMEOUT) return "timeout";
  if (code === FETCH_ERROR.RESOLVE_HOST) return "domain";
  if (code === FETCH_ERROR.SSL_PEER || code === FETCH_ERROR.SSL_CONNECT) return "ssl";
  if (code === FETCH_ERROR.CONNECT_FAILED || code === FETCH_ERROR.EMPTY_REPLY) return "connection";
  return "unknown";
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
