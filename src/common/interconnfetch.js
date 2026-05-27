const FETCH_TAG = "fetch";
const HS_TAG = "__hs__";
const TIMEOUT = 3000;

let fetchAvailable = false;
let systemFetch = null;
let interconnectModule = null;

try {
  systemFetch = require("@system.fetch");
} catch (e) {
  systemFetch = null;
}

try {
  interconnectModule = require("@system.interconnect");
} catch (e) {
  interconnectModule = null;
}

let fileModule = null;
try {
  fileModule = require("@system.file");
} catch (e) {
  fileModule = null;
}

function base64ToBytes(base64) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var lookup = {};
  for (var i = 0; i < chars.length; i++) {
    lookup[chars[i]] = i;
  }
  base64 = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  var len = base64.length;
  var padding = 0;
  if (len > 0 && base64.charAt(len - 1) === "=") padding++;
  if (len > 1 && base64.charAt(len - 2) === "=") padding++;
  var bufLen = Math.floor((len * 3) / 4 - padding);
  if (bufLen < 0) bufLen = 0;
  var bytes = new Uint8Array(bufLen);
  var p = 0;
  for (var i = 0; i < len; i += 4) {
    var enc1 = lookup[base64.charAt(i)];
    var enc2 = lookup[base64.charAt(i + 1)];
    var enc3 = lookup[base64.charAt(i + 2)];
    var enc4 = lookup[base64.charAt(i + 3)];
    bytes[p++] = (enc1 << 2) | (enc2 >> 4);
    if (base64.charAt(i + 2) !== "=") {
      bytes[p++] = ((enc2 & 15) << 4) | (enc3 >> 2);
    }
    if (base64.charAt(i + 3) !== "=") {
      bytes[p++] = ((enc3 & 3) << 6) | enc4;
    }
  }
  return bytes;
}

function writeBinaryFile(uri, bytes) {
  return new Promise((resolve, reject) => {
    if (!fileModule) {
      reject(new Error("file module not available"));
      return;
    }
    fileModule.writeArrayBuffer({
      uri: uri,
      buffer: bytes,
      success: () => resolve(uri),
      fail: (data, code) => {
        fileModule.writeArrayBuffer({
          uri: uri,
          buffer: bytes.buffer,
          success: () => resolve(uri),
          fail: (data2, code2) => reject(new Error("write failed: " + code2)),
        });
      },
    });
  });
}

function checkFetchAvailable() {
  return new Promise((resolve) => {
    // fetchAvailable = false;
    // resolve(false);
    // return;
    if (!systemFetch) {
      resolve(false);
      return;
    }

    systemFetch.fetch({
      url: "https://www.baidu.com",
      timeout: 3000,
      success: () => {
        fetchAvailable = true;
        resolve(true);
      },
      fail: () => {
        fetchAvailable = false;
        resolve(false);
      },
    });
  });
}

class InterconnFetchClient {
  constructor() {
    this.requests = new Map();
    this.conn = null;
    this.promise = null;
    this.resolve = null;
    this.timeout = null;
    this.open = false;
    this._inited = false;
  }

  _init() {
    if (this._inited) return true;
    if (!interconnectModule) return false;
    try {
      this.conn = interconnectModule.instance();
      if (!this.conn) return false;
    } catch (e) {
      return false;
    }

    this.conn.onmessage = ({ data }) => {
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        this.promise = null;
        this.resolve = null;
        this.open = false;
      }, TIMEOUT);

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        return;
      }
      const { tag, ...payload } = parsed;

      if (tag === HS_TAG) {
        const count = payload.count || 0;
        if (count > 0) {
          this.open = true;
          if (this.resolve) {
            const res = this.resolve;
            this.resolve = null;
            res();
          } else {
            this.promise = Promise.resolve();
          }
        }
        if (count < 2) {
          this.conn.send({
            data: { tag: HS_TAG, count: count + 1 },
          });
        }
      } else if (tag === FETCH_TAG) {
        const { resp, id } = payload;
        const req = this.requests.get(id);
        if (req && !req.settled) {
          req.settled = true;
          this.requests.delete(id);
          req.resolve(resp);
        }
      }
    };

    this.conn.onclose = () => {
      this.open = false;
      this.rejectAll(new Error("connection closed"));
    };
    this.conn.onerror = () => {
      this.open = false;
      this.rejectAll(new Error("connection error"));
    };
    this.conn.onopen = () => {
      this._ensureHandshake();
    };

    this._inited = true;
    return true;
  }

  rejectAll(err) {
    this.requests.forEach((req) => {
      if (req && !req.settled && req.reject) {
        req.settled = true;
        req.reject(err);
      }
    });
    this.requests.clear();
  }

  async _ensureHandshake() {
    if (this.promise) {
      await this.promise;
      return;
    }
    this.promise = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.promise = null;
        this.resolve = null;
        reject(new Error("handshake timeout"));
      }, TIMEOUT);
      this.resolve = () => {
        clearTimeout(t);
        resolve();
      };
      this.conn.send({
        data: { tag: HS_TAG, count: 0 },
      });
    });
    await this.promise;
  }

  async _sendFetch(id, url, options) {
    await this._ensureHandshake();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onceResolve = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const onceReject = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      this.requests.set(id, { resolve: onceResolve, reject: onceReject, settled: false });
      this.conn.send({
        data: {
          tag: FETCH_TAG,
          id,
          url,
          options,
        },
        fail: (err) => {
          const req = this.requests.get(id);
          if (req && !req.settled) {
            req.settled = true;
            this.requests.delete(id);
            req.reject(err);
          }
        },
      });
    });
  }

  async fetch(url, options) {
    if (!this._init()) {
      throw new Error("interconnect not available");
    }
    const id = url + Math.random().toFixed(5);
    const resp = await this._sendFetch(id, url, options);
    return {
      data: resp.body,
      statusCode: resp.status,
      headers: resp.headers,
    };
  }
}

const interconnClient = new InterconnFetchClient();

let _tempId = 0;
function getTempUri(url) {
  _tempId++;
  var hash = 0;
  for (var i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return "internal://files/_icf_" + Math.abs(hash) + "_" + _tempId;
}

export default {
  fetch(params) {
    const doFetch = async () => {
      if (!fetchAvailable) {
        await checkFetchAvailable();
      }
      if (fetchAvailable) {
        return systemFetch.fetch(params);
      }
      const {
        url,
        method,
        header,
        body,
        responseType,
        success,
        fail,
        complete,
      } = params;
      const options = {
        method: method || "GET",
        headers: header || {},
        body: body || undefined,
        raw: responseType === "file" || responseType === "arraybuffer",
      };
      try {
        const resp = await interconnClient.fetch(url, options);
        let data = resp.data;
        if (responseType === "json") {
          try {
            data = JSON.parse(data);
          } catch (e) {
            // keep raw
          }
        } else if (responseType === "file") {
          try {
            var bytes = base64ToBytes(data);
            var uri = getTempUri(url);
            data = await writeBinaryFile(uri, bytes);
          } catch (e) {
            throw new Error("save file failed: " + (e.message || e));
          }
        }
        if (success && typeof success === "function") {
          success({ data });
        }
        if (complete && typeof complete === "function") {
          complete();
        }
      } catch (err) {
        if (fail && typeof fail === "function") {
          fail(err.message || err, 0);
        }
        if (complete && typeof complete === "function") {
          complete();
        }
      }
    };
    return doFetch();
  },
};
