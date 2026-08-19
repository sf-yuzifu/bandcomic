import { safeJsonParse } from "./jsonUtils";
import { base64ToBytes } from "./base64";
import { getConnection, registerFetchHandler, registerActivityHandler } from "./interconnectHub";

const FETCH_TAG = "fetch";
const FETCH_CHUNK_TAG = "fetch-chunk";
const FETCH_ACK_TAG = "fetch-ack";
const HS_TAG = "__hs__";
const TIMEOUT = 3000;
const IDLE_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 20000;
const MAX_CHUNK_SIZE = 4096;

let systemFetch = null;

try {
  systemFetch = require("@system.fetch");
} catch (e) {
  systemFetch = null;
}

let fileModule = null;
try {
  fileModule = require("@system.file");
} catch (e) {
  fileModule = null;
}

function hexDecode(hex) {
  hex = hex.replace(/[^0-9a-fA-F]/g, "");
  const len = (hex.length / 2) | 0;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function utf8ToString(bytes) {
  const codes = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) {
      codes.push(b);
    } else if (b < 0xe0 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
      codes.push(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 1;
    } else if (
      b < 0xf0 &&
      i + 2 < bytes.length &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (bytes[i + 2] & 0xc0) === 0x80
    ) {
      codes.push(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 2;
    } else if (
      b >= 0xf0 &&
      i + 3 < bytes.length &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (bytes[i + 2] & 0xc0) === 0x80 &&
      (bytes[i + 3] & 0xc0) === 0x80
    ) {
      const cp =
        (((b & 0x07) << 18) |
          ((bytes[i + 1] & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f)) -
        0x10000;
      codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 3;
    } else {
      codes.push(0xfffd);
    }
  }
  const CHUNK = 8192;
  const parts = [];
  for (let i = 0; i < codes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, codes.slice(i, i + CHUNK)));
  }
  return parts.join("");
}

function decodeBody(text, encoding) {
  switch (encoding) {
    case "hex":
      return hexDecode(text);
    case "base64":
      return base64ToBytes(text);
    default:
      return text;
  }
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

function writeChunkFile(uri, bytes, append) {
  return new Promise((resolve, reject) => {
    if (!fileModule) {
      reject(new Error("no file"));
      return;
    }
    fileModule.writeArrayBuffer({
      uri: uri,
      buffer: bytes,
      append: append || false,
      success: () => resolve(),
      fail: (_, code) => {
        fileModule.writeArrayBuffer({
          uri: uri,
          buffer: bytes.buffer,
          append: append || false,
          success: () => resolve(),
          fail: (__, code2) => reject(new Error("chunk write: " + code2)),
        });
      },
    });
  });
}

function readBinaryFile(uri) {
  return new Promise((resolve, reject) => {
    if (!fileModule) {
      reject(new Error("no file"));
      return;
    }
    fileModule.readArrayBuffer({
      uri: uri,
      success: (bufData) => resolve(new Uint8Array(bufData.buffer)),
      fail: (_, code) => reject(new Error("chunk read: " + code)),
    });
  });
}

// 是否优先走网桥通道:用户在设置中开启,或设备为小米手环10 Pro(不支持快应用原生 fetch)。
// 部分设备直连能通国内 CDN 但因 mbedTLS 缺少 ECDHE 套件无法握手现代托管站点(curl 35),
// 这类"部分站点不通"无法靠探测自动识别,故提供手动开关。
function preferBridge() {
  if (typeof global === "undefined") return false;
  if (global.APP_SETTING && global.APP_SETTING.preferBridge === true) return true;
  if (typeof global.isXiaomiSmartBand10Pro === "function" && global.isXiaomiSmartBand10Pro()) {
    return true;
  }
  return false;
}

const LOCAL_CAPS = {
  version: 3,
  chunk: true,
  maxChunkSize: MAX_CHUNK_SIZE,
  encodings: ["text", "base64", "hex"],
  compressions: ["none"],
  ack: true,
  ackWindow: 4,
};

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
    // 连接与 onmessage 分发由 interconnectHub 统一管理，这里只注册本协议处理器
    this.conn = getConnection();
    if (!this.conn) return false;

    registerActivityHandler(() => {
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        this.open = false;
      }, IDLE_TIMEOUT);
    });

    registerFetchHandler((parsed) => {
      this._onFetchMessage(parsed);
    });

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

  _onFetchMessage(parsed) {
    const { tag, ...payload } = parsed;

    if (tag === HS_TAG) {
      const count = payload.count || 0;
      if (count > 0) {
        this.open = true;
        if (this.resolve) {
          const res = this.resolve;
          res();
        }
      }
      if (count < 2) {
        this.conn.send({
          data: {
            tag: HS_TAG,
            count: count + 1,
            caps: LOCAL_CAPS,
          },
        });
      }
    } else if (tag === FETCH_TAG) {
      const { resp, id } = payload;
      const req = this.requests.get(id);
      if (!req || req.settled) return;
      if (resp && resp.chunked) {
        req.header = resp;
        req.received = 0;
        req.ack = resp.ack === true;
        req.chunkCount = resp.chunkCount || 0;
        req.chunkBuffer = {};
        req.nextAck = 0;
        req.chunkPromises = [];
        req.resetTimer();
      } else {
        req.settled = true;
        this.requests.delete(id);
        req.resolve(resp);
      }
    } else if (tag === FETCH_CHUNK_TAG) {
      const { id, seq, data: chunkData } = payload;
      const req = this.requests.get(id);
      if (!req || req.settled) return;
      const encoding = (req.header && req.header.bodyEncoding) || "base64";
      req.received++;
      req.resetTimer();

      // 乱序缓存：按 seq 落位
      let decoded;
      if (encoding === "text") {
        req.chunkBuffer[seq] = chunkData;
      } else {
        decoded = decodeBody(chunkData, encoding);
        if (decoded instanceof Uint8Array) {
          req.chunkBuffer[seq] = decoded;
        }
      }

      // 如果用了 onChunk，记录其 Promise 以便后续等待
      if (req.onChunk) {
        const toWrite = encoding === "text" ? chunkData : decoded;
        if (toWrite !== undefined) {
          req.chunkPromises.push(req.onChunk(toWrite, seq));
        }
      }

      // 计算连续前沿：从 nextAck 起最长的连续已收区间
      while (req.chunkBuffer[req.nextAck] !== undefined) {
        req.nextAck++;
      }

      // 发送 fetch-ack（累计确认）
      if (req.ack) {
        this.conn.send({
          data: {
            tag: FETCH_ACK_TAG,
            id: id,
            ack: req.nextAck,
          },
        });
      }

      // 检查是否全部到齐
      if (req.nextAck >= req.chunkCount) {
        req.settled = true;
        this.requests.delete(id);

        // 等待所有 onChunk 写入完成后再 resolve
        const finish = function () {
          // 按顺序拼接
          let raw;
          if (encoding === "text") {
            const parts = [];
            for (let i = 0; i < req.chunkCount; i++) {
              parts.push(req.chunkBuffer[i] || "");
            }
            raw = parts.join("");
          } else {
            let totalLen = 0;
            for (let i = 0; i < req.chunkCount; i++) {
              const buf = req.chunkBuffer[i];
              if (buf instanceof Uint8Array) {
                totalLen += buf.length;
              }
            }
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (let i = 0; i < req.chunkCount; i++) {
              const buf = req.chunkBuffer[i];
              if (buf instanceof Uint8Array) {
                merged.set(buf, offset);
                offset += buf.length;
              }
            }
            raw = merged;
          }

          if (req.onChunk) {
            req.resolve({
              ...req.header,
              body: null,
            });
          } else {
            req.resolve({
              ...req.header,
              body: raw,
            });
          }
        };

        if (req.chunkPromises && req.chunkPromises.length > 0) {
          Promise.all(req.chunkPromises)
            .then(finish)
            .catch(function (e) {
              req.reject(new Error("chunk write failed: " + e));
            });
        } else {
          finish();
        }
      }
    }
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
    // 会话级握手：已打开直接返回；握手在途则复用同一个 promise，
    // 避免并发请求互相覆盖单槽的 promise/resolve 导致先发的请求永远等不到回包
    if (this.open) return;
    if (this.promise) return this.promise;

    this.promise = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.promise = null;
        this.resolve = null;
        this.open = false;
        reject(new Error("handshake timeout"));
      }, TIMEOUT);
      this.resolve = () => {
        clearTimeout(t);
        this.open = true;
        this.promise = null;
        this.resolve = null;
        resolve();
      };
      this.conn.send({
        data: { tag: HS_TAG, count: 0, caps: LOCAL_CAPS },
      });
    });
    return this.promise;
  }

  async _sendFetch(id, url, options, onChunk) {
    await this._ensureHandshake();
    return new Promise((resolve, reject) => {
      let settled = false;
      // 请求级超时：丢 chunk 且 go-back-N 重传也失败、或插件卡死时，
      // reject 让页面报错而不是永远转圈；同时关闭会话让后续请求重新握手
      const onRequestTimeout = () => {
        const req = this.requests.get(id);
        if (req && !req.settled) {
          req.settled = true;
          this.requests.delete(id);
          this.open = false;
          req.reject(new Error("request timeout"));
        }
      };
      const req = {
        resolve: null,
        reject: null,
        settled: false,
        onChunk: onChunk || null,
        timer: null,
        // BLE 上数 MB 图片分片下载整体耗时可能远超 20s，但只要分片还在持续到达
        // 就不应判超时；每收到首包/分片都重置计时器，仅"连续 20s 无任何进展"才超时
        resetTimer: () => {
          clearTimeout(req.timer);
          req.timer = setTimeout(onRequestTimeout, REQUEST_TIMEOUT);
        },
      };
      req.resolve = (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(req.timer);
          resolve(value);
        }
      };
      req.reject = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(req.timer);
          reject(err);
        }
      };
      this.requests.set(id, req);
      req.resetTimer();
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

  async fetch(url, options, onChunk) {
    if (!this._init()) {
      throw new Error("interconnect not available");
    }
    const id = url + Math.random().toFixed(5);
    const resp = await this._sendFetch(id, url, options, onChunk);
    if (resp.ok === false && !resp.status) {
      throw new Error(resp.statusText || "interconnect fetch failed");
    }
    let body = resp.body;
    if (body === null) {
      return {
        data: null,
        statusCode: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      };
    }
    if (!resp.chunked) {
      const encoding = resp.bodyEncoding;
      if (encoding) {
        body = decodeBody(body, encoding);
        if (!resp.raw && typeof body !== "string") {
          body = utf8ToString(body);
        }
      } else if (resp.raw) {
        body = base64ToBytes(body);
      }
    } else if (!resp.raw && body instanceof Uint8Array) {
      body = utf8ToString(body);
    }
    return {
      data: body,
      statusCode: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    };
  }
}

const interconnClient = new InterconnFetchClient();

// 优先级任务队列：interconnect 通道是单瓶颈链路，串行执行避免并发握手覆盖、
// 多路分片 ACK 交错；priority 数值小的先执行（同级按入队先后），
// 让用户可见的请求（当前页、详情 JSON）排在预加载/封面等后台请求前面
const taskQueue = [];
let queueRunning = false;

function pumpQueue() {
  if (queueRunning || taskQueue.length === 0) return;
  let best = 0;
  for (let i = 1; i < taskQueue.length; i++) {
    if (taskQueue[i].priority < taskQueue[best].priority) {
      best = i;
    }
  }
  const item = taskQueue.splice(best, 1)[0];
  queueRunning = true;
  item.run().then(
    (value) => {
      queueRunning = false;
      item.resolve(value);
      pumpQueue();
    },
    (err) => {
      queueRunning = false;
      item.reject(err);
      pumpQueue();
    }
  );
}

function enqueueFetch(run, priority) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ run, priority, resolve, reject });
    pumpQueue();
  });
}

let _tempId = 0;
function getTempUri(url) {
  _tempId++;
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  let ext = "";
  const fragment = url.split("#")[1] || "";
  if (/\.bin$/i.test(fragment)) {
    ext = ".bin";
  }
  return "internal://files/_icf_" + Math.abs(hash) + "_" + Date.now() + "_" + _tempId + ext;
}

export default {
  isDirectAvailable() {
    return Promise.resolve(!preferBridge() && !!systemFetch);
  },
  fetch(params) {
    const doFetch = async () => {
      if (!preferBridge() && systemFetch) {
        return systemFetch.fetch(params);
      }
      const { url, method, header, body, responseType, success, fail, complete } = params;
      const options = {
        method: method || "GET",
        headers: header || {},
        body: body || undefined,
        raw: responseType === "file" || responseType === "arraybuffer",
      };
      try {
        const chunkFiles = [];
        const finalUri = responseType === "file" ? getTempUri(url) : null;
        let onChunk = null;
        if (responseType === "file") {
          onChunk = async function (bytes, seq) {
            const partUri = finalUri + "." + seq;
            await writeChunkFile(partUri, bytes);
            const idx = chunkFiles.indexOf(partUri);
            if (idx === -1) {
              chunkFiles.push(partUri);
            }
          };
        }
        const resp = await interconnClient.fetch(url, options, onChunk);
        let data = resp.data;
        if (responseType === "json") {
          data = safeJsonParse(data, data);
        } else if (responseType === "file") {
          try {
            if (chunkFiles.length > 0) {
              // 按 seq 排序，防止异步写入完成顺序乱序
              chunkFiles.sort(function (a, b) {
                const seqA = parseInt(a.substring(a.lastIndexOf(".") + 1));
                const seqB = parseInt(b.substring(b.lastIndexOf(".") + 1));
                return seqA - seqB;
              });
              // 先写入第一个分片（覆盖创建），后续追加
              for (let i = 0; i < chunkFiles.length; i++) {
                let buf = await readBinaryFile(chunkFiles[i]);
                await writeChunkFile(finalUri, buf, i > 0);
                buf = null;
                try {
                  fileModule.delete({ uri: chunkFiles[i] });
                } catch (e) {}
              }
              data = finalUri;
            } else if (data instanceof Uint8Array) {
              data = await writeBinaryFile(finalUri, data);
            } else if (data !== null) {
              const bytes = base64ToBytes(data);
              data = await writeBinaryFile(finalUri, bytes);
            }
          } catch (e) {
            throw new Error("save file failed: " + (e.message || e));
          }
        }
        if (success && typeof success === "function") {
          success({
            data,
            statusCode: resp.statusCode,
            headers: resp.headers,
          });
        }
        if (complete && typeof complete === "function") {
          complete();
        }
        if (typeof global !== "undefined" && global.runGC) {
          global.runGC();
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
    // 直连设备的 systemFetch 是回调式调用，doFetch 立即返回，排队开销可忽略
    return enqueueFetch(doFetch, params.priority || 0);
  },
};
