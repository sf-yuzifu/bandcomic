import { safeJsonParse } from "./jsonUtils";
import { base64ToBytes } from "./base64";
import { getConnection, registerFetchHandler, registerActivityHandler } from "./interconnectHub";
import { getHttpStatus, isHttpSuccess, createHttpError, isFetchTempUri } from "./httpResponse";

const FETCH_TAG = "fetch";
const FETCH_CHUNK_TAG = "fetch-chunk";
const FETCH_ACK_TAG = "fetch-ack";
// v4 开放长度流（仅文件下载使用，协商不到 stream 时插件自动回落 v1-v3）
const FETCH_STREAM_TAG = "fetch-stream";
const FETCH_STREAM_ACK_TAG = "fetch-stream-ack";
const FETCH_STREAM_CANCEL_TAG = "fetch-stream-cancel";
const FETCH_STREAM_ERROR_TAG = "fetch-stream-error";
const HS_TAG = "__hs__";
const TIMEOUT = 3000;
const IDLE_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 20000;
// 分片上限：32K（base64 后约 43.7K 字符 + JSON 外壳，仍在 QAIC 传闻 48K 上限内；24K 已实测可行，
// 32K 待真机验证——若失败退回 24576）。新版插件协商为对端主导（clamp 到 [256, 64K]），
// 本声明即实际生效片长；旧版插件按自身 4096 上限钳制，同样兼容
const MAX_CHUNK_SIZE = 32768;
const ACK_WINDOW = 4;
const WRITE_BATCH_SIZE = 65536;
// 原始待写片（含正在写的片）≤128KiB，合并/补零输出≤128KiB。
// 分片链路最多256KiB受管二进制缓冲；不含消息的JSON/base64、原生副本及图片解码。
const FILE_PENDING_LIMIT = MAX_CHUNK_SIZE * ACK_WINDOW;
const FILE_WRITE_LIMIT = FILE_PENDING_LIMIT;
const FILE_FRAME_LIMIT = ACK_WINDOW;

let preferredArrayBuffer = false;
// 原生写无法主动撤回。超时只结束请求，直到原生回调返回前保留此槽，
// 禁止后续下载叠加永不返回的写入（JSON请求仍可继续）。
let nativeWrite = null;

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

function deletePartialFile(uri) {
  if (!fileModule) return;
  try {
    fileModule.delete({ uri: uri, fail: function () {} });
  } catch (e) {}
}

// 一次写最多尝试两种类型；记住上次成功类型，避免部分固件每片都先失败一次。
// 超时/取消后的迟到回调只释放原生槽并清理半成品，不重试也不启动下一笔写。
function writeFileBuffer(uri, bytes, options, owner) {
  return new Promise((resolve, reject) => {
    if (!fileModule) {
      reject(new Error("no file"));
      return;
    }
    if (nativeWrite) {
      reject(new Error("previous file write still pending"));
      return;
    }
    const token = {};
    nativeWrite = token;
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("file write timeout"));
    }, REQUEST_TIMEOUT);
    owner.cancelNative = (err) => {
      clearTimeout(timer);
      reject(err || new Error("file write cancelled"));
    };

    function finish(err) {
      clearTimeout(timer);
      if (nativeWrite === token) nativeWrite = null;
      owner.cancelNative = null;
      owner.stats.writeMs += Date.now() - started;
      if (timedOut || owner.cancelled) {
        deletePartialFile(uri);
        reject(new Error("file write cancelled"));
      } else if (err) {
        reject(err);
      } else {
        resolve();
      }
    }

    function attempt(arrayBuffer, retry) {
      let called = false;
      let buffer = bytes;
      if (arrayBuffer) {
        buffer =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      owner.stats.writeCalls++;
      const fail = (_, code) => {
        if (called) return;
        called = true;
        if (!retry && !timedOut && !owner.cancelled) {
          owner.stats.fallbacks++;
          attempt(!arrayBuffer, true);
        } else {
          finish(new Error("file write failed: " + code));
        }
      };
      try {
        fileModule.writeArrayBuffer({
          ...options,
          uri: uri,
          buffer: buffer,
          success: () => {
            if (called) return;
            called = true;
            preferredArrayBuffer = arrayBuffer;
            finish();
          },
          fail: fail,
        });
      } catch (e) {
        fail(e, e.message || e);
      }
    }
    attempt(preferredArrayBuffer, false);
  });
}

function createFileWriter(uri) {
  const frames = new Map();
  let pendingBytes = 0;
  let active = false;
  let direct = null;
  let nextSeq = 0;
  let contiguousEnd = 0;
  let writePos = 0; // 只在原生写成功后更新：实际文件长度
  let activePaddingBytes = 0;
  const writer = {
    cancelled: false,
    writtenChunks: 0,
    stats: { writeCalls: 0, fallbacks: 0, writeMs: 0, zeroBytes: 0, peakBytes: 0 },
    enqueue,
    cancel,
    finish(totalBytes) {
      if (writer.cancelled) throw new Error("file write cancelled");
      if (active || frames.size) throw new Error("file writes incomplete");
      if (typeof totalBytes === "number" && writePos !== totalBytes) {
        throw new Error("size mismatch: " + writePos + "/" + totalBytes);
      }
    },
    writeWhole(bytes) {
      return writeFileBuffer(uri, bytes, {}, writer);
    },
    report() {
      // Rspack按构建mode内联此常量，release不构造/保留测速日志文字。
      // eslint-disable-next-line no-undef
      if (process.env.NODE_ENV === "production") return;
      const s = writer.stats;
      console.debug(
        `文件写入 calls=${s.writeCalls} fallback=${s.fallbacks} ms=${s.writeMs} zero=${s.zeroBytes} peak=${s.peakBytes}`
      );
    },
  };

  function cancel(err) {
    if (writer.cancelled) return;
    writer.cancelled = true;
    if (writer.cancelNative) writer.cancelNative(err);
    frames.forEach((frame) => {
      frame.bytes = null;
      if (frame.reject) frame.reject(err || new Error("file write cancelled"));
      frame.resolve = frame.reject = null;
    });
    frames.clear();
    pendingBytes = 0;
  }

  function enqueue(bytes, seq, offset) {
    if (writer.cancelled) throw new Error("file write cancelled");
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CHUNK_SIZE) {
      throw new Error("bad file chunk size/encoding");
    }
    if (frames.size >= FILE_FRAME_LIMIT || pendingBytes + bytes.length > FILE_PENDING_LIMIT) {
      throw new Error("file write backlog limit");
    }
    if (direct === null) direct = typeof offset === "number";
    if (direct) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("bad chunk offset");
      const end = offset + bytes.length;
      if (!Number.isSafeInteger(end) || offset < contiguousEnd) {
        throw new Error("bad chunk extent");
      }
      if (seq === nextSeq && offset !== contiguousEnd) throw new Error("noncontiguous offset");
      frames.forEach((frame, otherSeq) => {
        if ((seq < otherSeq && end > frame.offset) || (seq > otherSeq && offset < frame.end)) {
          throw new Error("overlapping chunks");
        }
      });
    } else {
      offset = null; // 旧插件无可靠偏移：必须按序append，Promise也只在该片真正写完时完成
    }
    const promise = new Promise((resolve, reject) => {
      frames.set(seq, {
        bytes: bytes,
        offset: offset,
        end: offset === null ? null : offset + bytes.length,
        active: false,
        written: false,
        resolve: resolve,
        reject: reject,
      });
    });
    pendingBytes += bytes.length;
    writer.stats.peakBytes = Math.max(writer.stats.peakBytes, pendingBytes + activePaddingBytes);
    pump();
    return promise;
  }

  async function pump() {
    if (active || writer.cancelled) return;
    let first = null;
    let firstSeq = nextSeq;
    if (direct) {
      // 优先已到达、恰接文件末尾的片；没有则按到达顺序直写，不等待缺片。
      frames.forEach((frame, seq) => {
        if (frame.bytes && !frame.active && (!first || frame.offset === writePos)) {
          if (!first || first.offset !== writePos) {
            first = frame;
            firstSeq = seq;
          }
        }
      });
    } else {
      first = frames.get(nextSeq);
    }
    if (!first || !first.bytes) return;
    active = true;
    const batch = [first];
    let length = first.bytes.length;
    let end = direct ? first.end : null;
    let lastSeq = firstSeq;
    try {
      // 只合并已经到达的相邻片；不等凑满、不跨越原位覆盖/append的边界。
      while (length < WRITE_BATCH_SIZE) {
        const next = frames.get(lastSeq + 1);
        if (
          !next ||
          !next.bytes ||
          next.active ||
          length + next.bytes.length > WRITE_BATCH_SIZE ||
          (direct && (next.offset !== end || (first.offset < writePos && next.end > writePos)))
        )
          break;
        batch.push(next);
        length += next.bytes.length;
        end = next.end;
        lastSeq++;
      }
      const start = direct ? first.offset : writePos;
      const padLength = Math.max(0, start - writePos);
      const outputLength = padLength + length;
      if (outputLength > FILE_WRITE_LIMIT || (start < writePos && start + length > writePos)) {
        throw new Error("file write extent limit");
      }
      let output = first.bytes;
      if (batch.length > 1 || padLength) {
        // 合并与补零共用同一输出，避免先合并再补零产生第三份缓冲。
        writer.stats.peakBytes = Math.max(writer.stats.peakBytes, pendingBytes + outputLength);
        output = new Uint8Array(outputLength);
        let pos = padLength;
        batch.forEach((frame) => {
          output.set(frame.bytes, pos);
          pos += frame.bytes.length;
        });
      }
      batch.forEach((frame) => {
        frame.active = true;
        frame.bytes = null;
      });
      activePaddingBytes = padLength;
      const options = start < writePos ? { position: start } : { append: writePos > 0 };
      // 真机只允许position<文件长度；EOF及补零路径一律append/首次建文件。
      await writeFileBuffer(uri, output, options, writer);
      output = null;
      if (writer.cancelled) return;
      writePos = Math.max(writePos, start + length);
      pendingBytes -= length;
      writer.stats.zeroBytes += padLength;
      batch.forEach((frame) => {
        frame.written = true;
      });
      // 验证连续字节前沿，再释放已完成的帧记录；乱序已写片只留小标记。
      while (frames.has(nextSeq) && frames.get(nextSeq).written) {
        const frame = frames.get(nextSeq);
        if (direct && frame.offset !== contiguousEnd) throw new Error("noncontiguous offset");
        contiguousEnd += frame.end === null ? 0 : frame.end - frame.offset;
        frames.delete(nextSeq++);
      }
      writer.writtenChunks += batch.length;
      batch.forEach((frame) => {
        const resolve = frame.resolve;
        frame.resolve = frame.reject = null;
        resolve();
      });
      active = false;
      activePaddingBytes = 0;
      pump();
    } catch (e) {
      // batch可能已从frames移除；失败时也要结束其Promise，不能让请求漏出管理。
      batch.forEach((frame) => {
        if (frame.reject) frame.reject(e);
        frame.bytes = null;
        frame.resolve = frame.reject = null;
      });
      active = false;
      activePaddingBytes = 0;
      cancel(e);
    }
  }
  return writer;
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
  version: 4,
  chunk: true,
  maxChunkSize: MAX_CHUNK_SIZE,
  encodings: ["text", "base64", "hex"],
  compressions: ["none"],
  ack: true,
  // 累计ACK按实际落盘推进，窗口4帧保留接收/写盘流水线，并限制未落盘原始字节。
  ackWindow: ACK_WINDOW,
  stream: true,
};

// v4 流帧完整性校验：IEEE CRC-32（编码前原始字节）。slice-by-8 查表（8 张静态表，
// 每帧循环次数降为逐字节版的 1/8）——CRC 在 ACK 关键路径上（验过才回 ACK、插件才泵下一帧），
// 手环 JS 上逐字节版对 32K 帧要 3 万+ 次循环，是 v4 传输的 CPU 大头
let CRC_TABLES = null;
function crc32Num(bytes) {
  if (!CRC_TABLES) {
    CRC_TABLES = [new Uint32Array(256)];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC_TABLES[0][n] = c >>> 0;
    }
    for (let t = 1; t < 8; t++) {
      CRC_TABLES[t] = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        CRC_TABLES[t][n] =
          (CRC_TABLES[t - 1][n] >>> 8) ^ CRC_TABLES[0][CRC_TABLES[t - 1][n] & 0xff];
      }
    }
  }
  const T = CRC_TABLES;
  let crc = 0xffffffff;
  let i = 0;
  const len = bytes.length;
  while (i + 8 <= len) {
    const lo =
      (crc ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))) >>> 0;
    const hi =
      (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    crc =
      T[7][lo & 0xff] ^
      T[6][(lo >>> 8) & 0xff] ^
      T[5][(lo >>> 16) & 0xff] ^
      T[4][lo >>> 24] ^
      T[3][hi & 0xff] ^
      T[2][(hi >>> 8) & 0xff] ^
      T[1][(hi >>> 16) & 0xff] ^
      T[0][hi >>> 24];
    i += 8;
  }
  while (i < len) {
    crc = T[0][(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    i++;
  }
  return (crc ^ 0xffffffff) >>> 0;
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
      // 文件在首个响应头处判状态，v3/v4 不接收/写盘错误正文，也不为其推进 ACK。
      // JSON/text 仍交给业务层判断，源健康检测需要保留 HTTP 错误响应。
      if (req.sink && !isHttpSuccess(resp)) {
        req.stream = !!(resp && resp.stream);
        req.reject(createHttpError(resp));
        return;
      }
      if (resp && (resp.stream || resp.chunked)) {
        if (req.header) {
          req.reject(new Error("duplicate fetch header"));
          return;
        }
        req.header = resp;
        req.stream = resp.stream === true;
        req.received = 0;
        req.ack = resp.ack === true;
        req.chunkCount = req.stream ? null : resp.chunkCount || 0;
        req.chunkBuffer = Object.create(null);
        req.nextAck = 0;
        req.finalSeq = -1;
        req.maxSeenSeq = -1;
        req.encoding = resp.bodyEncoding || "base64";
        if (
          (!req.stream && (!Number.isSafeInteger(req.chunkCount) || req.chunkCount < 0)) ||
          (req.stream && !req.ack) ||
          ["base64", "hex", "text"].indexOf(req.encoding) === -1
        ) {
          req.reject(new Error("bad chunk header/encoding"));
          return;
        }
        req.resetTimer();
        // P2-35④：零分片头部即完成，不干等超时。
        if (!req.stream && req.chunkCount === 0) this._advance(req, id);
      } else {
        req.resolve(resp);
      }
    } else if (tag === FETCH_CHUNK_TAG) {
      const { id, seq, data: chunkData } = payload;
      const req = this.requests.get(id);
      if (!req || req.settled || !req.header || req.stream) return;
      const cs = req.header.chunkSize;
      const compressed = req.header.compression && req.header.compression !== "none";
      const offset = !compressed && typeof cs === "number" && cs > 0 ? seq * cs : null;
      this._receiveFrame(req, id, seq, chunkData, offset, undefined, false);
    } else if (tag === FETCH_STREAM_TAG) {
      const { id, seq, data: frameData, crc32, final, offset, totalBytes } = payload;
      const req = this.requests.get(id);
      if (!req || req.settled || !req.stream) return;
      this._receiveFrame(req, id, seq, frameData, offset, crc32, final === true, totalBytes);
    } else if (tag === FETCH_STREAM_ERROR_TAG) {
      const { id, message } = payload;
      const req = this.requests.get(id);
      if (!req || req.settled) return;
      req.reject(new Error(message || "stream error"));
    }
  }

  _sendAck(req, id) {
    if (!req.ack || req.settled) return;
    try {
      this.conn.send({
        data: { tag: req.stream ? FETCH_STREAM_ACK_TAG : FETCH_ACK_TAG, id, ack: req.nextAck },
        fail: (err) => req.reject(new Error("ACK send failed: " + err)),
      });
    } catch (e) {
      req.reject(e);
    }
  }

  _receiveFrame(req, id, seq, data, offset, crc, final, totalBytes) {
    try {
      if (!Number.isSafeInteger(seq) || seq < 0 || (!req.stream && seq >= req.chunkCount)) {
        throw new Error("bad chunk sequence");
      }
      // 已ACK的记录已释放；未ACK的false=正在写，true=已写完。两者都不能重复写。
      if (seq < req.nextAck || req.chunkBuffer[seq] !== undefined) {
        this._sendAck(req, id);
        return;
      }
      if (req.finalSeq >= 0 && (seq > req.finalSeq || final)) throw new Error("bad stream EOF");
      // ACK窗口只限制未落盘片，不再由接收速度无限向前推。越窗帧在解码前丢弃，等重传。
      if (req.sink && req.ack && seq >= req.nextAck + ACK_WINDOW) {
        this._sendAck(req, id);
        return;
      }
      let bytes = true;
      if (final) {
        if (seq <= req.maxSeenSeq) throw new Error("bad stream EOF");
        if (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes < 0)) {
          throw new Error("bad stream length");
        }
        req.finalSeq = seq;
        if (totalBytes !== undefined) req.header.totalBytes = totalBytes;
      } else {
        if (typeof data !== "string") throw new Error("bad chunk data");
        if (req.sink) {
          const wireLimit =
            req.encoding === "hex" ? MAX_CHUNK_SIZE * 2 : Math.ceil(MAX_CHUNK_SIZE / 3) * 4;
          if (data.length > wireLimit) throw new Error("file chunk too large");
        }
        bytes = decodeBody(data, req.encoding);
        if (crc !== undefined && bytes instanceof Uint8Array) {
          if (
            typeof crc !== "string" ||
            !/^[0-9a-f]{8}$/i.test(crc) ||
            crc32Num(bytes) !== parseInt(crc, 16)
          ) {
            // 坏片不入队、不续超时，只回重复ACK触发go-back-N。
            this._sendAck(req, id);
            return;
          }
        }
      }
      req.received++;
      req.maxSeenSeq = Math.max(req.maxSeenSeq, seq);
      req.resetTimer();
      if (req.sink && !final) {
        req.chunkBuffer[seq] = false;
        req.sink.enqueue(bytes, seq, typeof offset === "number" ? offset : null).then(
          () => {
            if (req.settled) return;
            req.chunkBuffer[seq] = true;
            req.resetTimer(); // 写盘也是进展；EOF之后继续受看门狗管理
            this._advance(req, id);
          },
          (err) => req.reject(err)
        );
        // 真正缺片才请求重传；仅等待原生写入时不主动反复回相同ACK。
        if (seq > req.nextAck && req.chunkBuffer[req.nextAck] === undefined) this._sendAck(req, id);
      } else {
        req.chunkBuffer[seq] = bytes;
        this._advance(req, id);
      }
    } catch (e) {
      req.reject(e);
    }
  }

  _advance(req, id) {
    try {
      const previousAck = req.nextAck;
      while (
        req.sink
          ? req.chunkBuffer[req.nextAck] === true
          : req.chunkBuffer[req.nextAck] !== undefined
      ) {
        if (req.sink) delete req.chunkBuffer[req.nextAck];
        req.nextAck++;
      }
      const done = req.stream
        ? req.finalSeq >= 0 && req.nextAck > req.finalSeq
        : req.nextAck >= req.chunkCount;
      // 总长/连续性检查在最终ACK之前完成，避免发送端先释放不可重传的数据。
      if (done && req.sink) req.sink.finish(req.header.totalBytes);
      if (!req.sink || req.nextAck !== previousAck) this._sendAck(req, id);
      if (!done || req.settled) return;
      let body = null;
      if (!req.sink) {
        const count = req.stream ? req.finalSeq : req.chunkCount;
        const parts = [];
        let length = 0;
        for (let i = 0; i < count; i++) {
          const part = req.chunkBuffer[i];
          parts.push(part);
          length += part.length;
        }
        if (req.encoding === "text") {
          body = parts.join("");
        } else {
          body = new Uint8Array(length);
          let pos = 0;
          parts.forEach((part) => {
            body.set(part, pos);
            pos += part.length;
          });
        }
      }
      req.resolve({ ...req.header, body });
    } catch (e) {
      req.reject(e);
    }
  }

  rejectAll(err) {
    this.requests.forEach((req) => {
      if (req && !req.settled) req.reject(err);
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

  async _sendFetch(id, url, options, sink, control) {
    await this._ensureHandshake();
    if (control && control.cancelled) throw new Error("fetch cancelled");
    return new Promise((resolve, reject) => {
      // 请求级超时：丢 chunk 且 go-back-N 重传也失败、或插件卡死时，
      // reject 让页面报错而不是永远转圈；同时关闭会话让后续请求重新握手
      const onRequestTimeout = () => {
        const req = this.requests.get(id);
        if (req && !req.settled) {
          req.reject(new Error("request timeout"));
          this.open = false;
        }
      };
      const req = {
        resolve: null,
        reject: null,
        settled: false,
        sink: sink || null,
        timer: null,
        // 仅新有效帧/写盘成功刷新；重复片和CRC坏片不能无限延长失败请求。
        resetTimer: () => {
          clearTimeout(req.timer);
          req.timer = setTimeout(onRequestTimeout, REQUEST_TIMEOUT);
        },
      };
      req.resolve = (value) => {
        if (!req.settled) {
          req.settled = true;
          clearTimeout(req.timer);
          this.requests.delete(id);
          req.chunkBuffer = null;
          req.sink = null;
          if (control) control.abort = null;
          resolve(value);
        }
      };
      req.reject = (err) => {
        if (!req.settled) {
          err = err || new Error("interconnect request failed");
          req.settled = true;
          clearTimeout(req.timer);
          this.requests.delete(id);
          if (req.sink) req.sink.cancel(err);
          req.sink = null;
          req.chunkBuffer = null;
          if (control) control.abort = null;
          if (req.stream && this.conn) {
            try {
              this.conn.send({
                data: { tag: FETCH_STREAM_CANCEL_TAG, id, reason: String(err.message || err) },
              });
            } catch (e) {}
          }
          reject(err);
        }
      };
      if (control) control.abort = () => req.reject(new Error("fetch cancelled"));
      this.requests.set(id, req);
      req.resetTimer();
      try {
        this.conn.send({
          data: { tag: FETCH_TAG, id, url, options },
          fail: (err) => req.reject(err),
        });
      } catch (e) {
        req.reject(e);
      }
    });
  }

  async fetch(url, options, sink, control) {
    if (!this._init()) {
      throw new Error("interconnect not available");
    }
    // 短 id：会话内自增即唯一（插件按 addr+pkg+id 键控，同 id 的 begin 会顶掉陈旧传输）；
    // 完整 URL 不进帧——此前每个分片帧与 ACK 双向都背负一两百字符的 URL
    const id = "r" + ++_reqSeq;
    const resp = await this._sendFetch(id, url, options, sink, control);
    if (sink && !isHttpSuccess(resp)) throw createHttpError(resp);
    if (resp.ok === false && !resp.status) {
      throw new Error(resp.statusText || "interconnect fetch failed");
    }
    let body = resp.body;
    if (body === null) {
      return {
        data: null,
        statusCode: getHttpStatus(resp),
        statusText: resp.statusText,
        headers: resp.headers,
        totalBytes: resp.totalBytes, // 分片头/流尾的总长，供调用方校验直写完整性
      };
    }
    if (!resp.chunked && !resp.stream) {
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
      statusCode: getHttpStatus(resp),
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
      item.control.finished = true;
      item.control.abort = null;
      item.resolve(value);
      pumpQueue();
    },
    (err) => {
      queueRunning = false;
      item.control.finished = true;
      item.control.abort = null;
      item.reject(err);
      pumpQueue();
    }
  );
}

function enqueueFetch(run, priority, control) {
  let item;
  const task = new Promise((resolve, reject) => {
    item = { run, priority, resolve, reject, control };
    taskQueue.push(item);
    pumpQueue();
  });
  // 可选取消句柄：未启动任务直接移出队列；在途网桥请求走统一失败/清理。
  task.cancel = () => {
    if (control.finished || control.cancelled) return;
    control.cancelled = true;
    const index = taskQueue.indexOf(item);
    if (index !== -1) {
      taskQueue.splice(index, 1);
      control.finished = true;
      item.resolve();
    } else if (control.abort) {
      control.abort();
    }
  };
  return task;
}

let _tempId = 0;
let _reqSeq = 0;
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
    const control = { cancelled: false, finished: false, abort: null };
    const doFetch = async () => {
      if (!preferBridge() && systemFetch) {
        return systemFetch.fetch({
          ...params,
          success: (response) => {
            const result = { ...response, statusCode: getHttpStatus(response) };
            if (params.responseType === "file" && !isHttpSuccess(response)) {
              if (isFetchTempUri(result.data)) deletePartialFile(result.data);
              const error = createHttpError(response);
              if (params.fail) params.fail(error.message, error.httpStatus);
              return;
            }
            if (params.success) params.success(result);
          },
        });
      }
      const { url, method, header, body, responseType, success, fail, complete } = params;
      const options = {
        method: method || "GET",
        headers: header || {},
        body: body || undefined,
        raw: responseType === "file" || responseType === "arraybuffer",
        // 文件下载走 v4 开放流 + 固定分片（新版插件）：HTTP 下载与 BLE 传输重叠省整段 body 时间；
        // 每帧带显式 offset（帧自定位 → 水位线直写，无需定长推算），fixedChunks 让插件合并
        // HTTP 短读保持满帧（帧数最小化）。旧插件忽略 unknown 字段自动回落 v1-v3（v3 定长
        // 分片 offset = seq × chunkSize 推算，同样直写；更老的无 offset 则回退有序 append）
        stream: responseType === "file" ? true : undefined,
        fixedChunks: responseType === "file" ? true : undefined,
        // 跟随 3xx 重定向（漫画 CDN 签名跳转常见；插件侧上限 10 跳，旧插件忽略该字段）
        followRedirects: true,
      };
      // v3用seq×chunkSize，新v4用显式offset直写；旧v4缺偏移时按序append。
      // 收片窗口内保留接收/写盘重叠；已到达相邻片最多合并64KiB，写成功才推进ACK。
      const finalUri = responseType === "file" ? getTempUri(url) : null;
      const unprotect =
        finalUri &&
        typeof global !== "undefined" &&
        global.$storage &&
        typeof global.$storage.protectTempFile === "function"
          ? global.$storage.protectTempFile(finalUri)
          : null;
      const writer = finalUri ? createFileWriter(finalUri) : null;
      try {
        if (writer && nativeWrite) throw new Error("previous file write still pending");
        const resp = await interconnClient.fetch(url, options, writer, control);
        if (control.cancelled) throw new Error("fetch cancelled");
        control.abort = writer ? () => writer.cancel(new Error("fetch cancelled")) : null;
        let data = resp.data;
        if (responseType === "json") {
          data = safeJsonParse(data, data);
        } else if (responseType === "file") {
          if (writer.writtenChunks === 0) {
            // v1单消息或空文件也带原生写超时/类型缓存；流式总长已在最终ACK前检查。
            const bytes =
              data instanceof Uint8Array
                ? data
                : data === null
                  ? new Uint8Array(0)
                  : base64ToBytes(data);
            await writer.writeWhole(bytes);
          }
          data = finalUri;
          writer.report();
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
        if (writer) {
          writer.cancel(err);
          writer.report();
          deletePartialFile(finalUri);
        }
        if (fail && typeof fail === "function") {
          fail(err.message || err, err.httpStatus || 0);
        }
        if (complete && typeof complete === "function") {
          complete();
        }
      } finally {
        if (unprotect) unprotect();
      }
    };
    // 直连设备的 systemFetch 是回调式调用，doFetch 立即返回，排队开销可忽略
    return enqueueFetch(doFetch, params.priority || 0, control);
  },
};
