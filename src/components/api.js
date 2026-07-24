import fetch from "./interconnfetch";

export const FETCH_ERROR = {
  TIMEOUT: 28,
  RESOLVE_HOST: 6,
  SSL_PEER: 60,
  SSL_CONNECT: 35,
  CONNECT_FAILED: 7,
  EMPTY_REPLY: 52,
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
    url = url.replace("<" + key + ">", map[key]);
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
