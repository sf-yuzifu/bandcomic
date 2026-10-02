// 原生 Vela fetch 使用 code，网桥响应使用 statusCode（协议头使用 status）。
export function getHttpStatus(response) {
  if (!response) return 0;
  const raw = response.statusCode != null ? response.statusCode
    : response.code != null ? response.code : response.status;
  if (raw == null) return null;
  const status = Number(raw);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

export function isHttpSuccess(response) {
  const status = getHttpStatus(response);
  // 兼容未带状态码的旧接口；文件内容仍由下载页校验，不能靠缺省 200 放行坏状态码。
  return !!response && response.ok !== false && (status === null || (status >= 200 && status < 300));
}

export function createHttpError(response) {
  const status = getHttpStatus(response);
  const error = new Error(status ? "HTTP " + status : "invalid HTTP response");
  error.httpStatus = status || 0;
  return error;
}

export function isFetchTempUri(uri) {
  return typeof uri === "string" && (
    uri.indexOf("internal://files/_icf_") === 0 || uri.indexOf("internal://cache/") === 0
  );
}
