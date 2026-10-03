import { getHttpStatus, isHttpSuccess, createHttpError, isFetchTempUri } from "./httpResponse";

let systemFetch = null;
try {
  systemFetch = require("@system.fetch");
} catch (e) {
  systemFetch = null;
}

let _gatewayFetchFileModule = null;
try {
  _gatewayFetchFileModule = require("@system.file");
} catch (e) {
  _gatewayFetchFileModule = null;
}

function deleteTempFile(uri) {
  if (!_gatewayFetchFileModule || !isFetchTempUri(uri)) return;
  try {
    _gatewayFetchFileModule.delete({ uri: uri, fail: function () {} });
  } catch (e) {}
}

export function isNativeFetchSupported() {
  return !!(systemFetch && typeof systemFetch.fetch === "function");
}

/**
 * 专为本地网关/HTTP漫画源设计的原生 fetch。
 * 纯粹直接调用 @system.fetch，完全不受 preferBridge 或网桥分流规则影响。
 *
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.method="GET"]
 * @param {Object} [params.header={}]
 * @param {string|Object|ArrayBuffer} [params.data]
 * @param {string} [params.responseType="text"] - "text" 或 "file"
 * @param {Function} [params.success]
 * @param {Function} [params.fail]
 * @param {Function} [params.complete]
 * @returns {Promise<{code: number, statusCode: number, data: any, headers: Object}>}
 */
export function gatewayFetch(params) {
  return new Promise((resolve, reject) => {
    if (!isNativeFetchSupported()) {
      const err = new Error("Device does not support native fetch");
      err.code = -1;
      if (params.fail) params.fail(err.message, err.code);
      if (params.complete) params.complete();
      reject(err);
      return;
    }

    const {
      url,
      method = "GET",
      header = {},
      data,
      responseType = "text",
    } = params;

    let finished = false;
    const finish = (err, result) => {
      if (finished) return;
      finished = true;
      if (err) {
        if (params.fail) params.fail(err.message || String(err), err.code || 0);
        reject(err);
      } else {
        if (params.success) params.success(result);
        resolve(result);
      }
      if (params.complete) params.complete();
    };

    try {
      systemFetch.fetch({
        url: url,
        method: method,
        header: header,
        data: data,
        responseType: responseType,
        success: function (response) {
          const statusCode = getHttpStatus(response);
          const result = {
            ...response,
            statusCode: statusCode,
          };

          if (responseType === "file" && !isHttpSuccess(response)) {
            if (result.data) {
              deleteTempFile(result.data);
            }
            const httpErr = createHttpError(response);
            finish(httpErr);
            return;
          }

          finish(null, result);
        },
        fail: function (failData, code) {
          const errMsg = typeof failData === "string" ? failData : "Fetch failed with code: " + code;
          const err = new Error(errMsg);
          err.code = code;
          finish(err);
        },
      });
    } catch (e) {
      finish(e);
    }
  });
}
