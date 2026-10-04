import { gatewayFetch } from "./gatewayFetch";
import { safeJsonParse } from "./jsonUtils";
import { base64Encode } from "./base64";

const PROBE_BYTES = [0, 1, 127, 128, 255, 0, 42, 13, 10];
const CHUNK_BYTES = 16 * 1024;
const MAX_COVER_BYTES = 2 * 1024 * 1024;

// file.readArrayBuffer 在不同固件返回 ArrayBuffer 或 Uint8Array；只发送当前视图。
export function exactBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (value && value.buffer instanceof ArrayBuffer && Number.isInteger(value.byteLength)) {
    return value.buffer.slice(value.byteOffset || 0, (value.byteOffset || 0) + value.byteLength);
  }
  throw new Error("Invalid binary file data");
}

export async function sendHttpData(request, comics, sources, covers, options) {
  const current = options.isCurrent;
  const fetch = options.fetch || gatewayFetch;
  const check = () => { if (!current()) throw new Error("Sync cancelled"); };
  const json = async (url, method, data, binary = false) => {
    for (let attempt = 0; ; attempt++) {
      check();
      try {
        const header = {};
        let payload;
        if (binary) {
          header["Content-Type"] = "application/octet-stream";
          payload = data;
        } else if (data != null) {
          header["Content-Type"] = "application/json";
          payload = JSON.stringify(data);
        }
        const response = await fetch({ url, method, data: payload, header, responseType: "text" });
        check();
        const status = response.statusCode || response.code;
        if (status !== 200) {
          const error = new Error("HTTP " + status);
          error.noRetry = status < 500;
          throw error;
        }
        const parsed = typeof response.data === "string" ? safeJsonParse(response.data, null) : response.data;
        if (!parsed || typeof parsed !== "object") throw new Error("Invalid HTTP response");
        return parsed;
      } catch (error) {
        if (!current() || error.noRetry || attempt >= 1) throw error;
      }
    }
  };

  const config = request.http;
  if (!config || config.protocol !== 1 || !/^[\w-]+$/.test(request.session || "") ||
      !Array.isArray(config.endpoints) || !config.endpoints.length || config.endpoints.length > 2) {
    return { fallback: true, error: "Invalid HTTP sync configuration" };
  }
  let root = null;
  let useBinary = false;
  let lastError = "";
  for (const endpoint of config.endpoints) {
    check();
    if (typeof endpoint !== "string" || !/^http:\/\/[^/?#]+:\d+$/.test(endpoint)) continue;
    try {
      const health = await json(endpoint + "/control/health", "GET");
      if (health.service !== "bandcomic-local-http" || health.instanceId !== config.instanceId ||
          !health.capabilities || health.capabilities.httpDataSync !== 1) {
        throw new Error("HTTP服务身份校验不匹配");
      }
      const candidate = endpoint + "/control/sync/" + request.session;
      let binaryOk = false;
      try {
        const probe = await json(candidate + "/probe", "POST", new Uint8Array(PROBE_BYTES).buffer, true);
        if (probe.ok === true) binaryOk = true;
      } catch (e) {
        // 部分穿戴设备固件的 fetch 无法直接发送 ArrayBuffer，降级探测 JSON
      }
      if (!binaryOk) {
        const probeJson = await json(candidate + "/probe", "POST", { probe: "test" });
        if (probeJson.ok !== true) throw new Error("探针校验失败");
      }
      root = candidate;
      useBinary = binaryOk;
      break;
    } catch (error) {
      lastError = error && (error.message || String(error));
      if (!current()) throw error;
    }
  }
  if (!root) return { fallback: true, error: lastError || "HTTP探针未通过" };

  const send = async (resource, method, data, binary = false) => {
    const response = await json(root + "/" + resource, method, data, binary);
    if (response.ok !== true) throw new Error(response.message || "HTTP sync rejected");
  };
  // 一旦尝试提交列表，就固定 HTTP 通道；请求应答丢失也不会另启互联同步。
  await send("metadata", "POST", { kind: "header", comicCount: comics.length, sourceCount: sources.length });
  for (const entry of [{ kind: "comics", items: comics }, { kind: "sources", items: sources }]) {
    for (let offset = 0; offset < entry.items.length;) {
      let size = Math.min(16, entry.items.length - offset);
      const batch = { kind: entry.kind, offset, items: entry.items.slice(offset, offset + size) };
      // 每个 UTF-16 code unit 的 UTF-8 字节数最多 3，给宿主的 64KiB 上限留余量。
      while (size > 1 && JSON.stringify(batch).length * 3 > 64 * 1024) {
        size--;
        batch.items = entry.items.slice(offset, offset + size);
      }
      await send("metadata", "POST", batch);
      offset += size;
    }
  }
  await send("metadata", "POST", { kind: "done" });
  const byId = {};
  covers.forEach((cover) => { byId["$" + cover.id] = cover; });
  let skipped = 0;
  for (let index = 0; index < comics.length; index++) {
    check();
    const comic = comics[index];
    const cover = byId["$" + comic.id];
    const uri = cover && (cover.coverMissing ? "" : "internal://files/" + (cover.storageId || cover.id) + "/cover");
    const info = uri && await options.readFile("get", { uri });
    check();
    const length = info && info.length;
    let reason = "";
    if (!Number.isSafeInteger(length) || length <= 0) reason = "missing";
    else if (length > MAX_COVER_BYTES) reason = "too-large";
    else {
      for (let position = 0; position < length; position += CHUNK_BYTES) {
        const size = Math.min(CHUNK_BYTES, length - position);
        const data = await options.readFile("readArrayBuffer", { uri, position, length: size });
        check();
        let buffer;
        try { buffer = exactBuffer(data && data.buffer); } catch (error) { reason = "read-failed"; break; }
        if (buffer.byteLength !== size) { reason = "short-read"; break; }
        try {
          if (useBinary) {
            await send("covers/" + index + "?offset=" + position + "&total=" + length, "PUT", buffer, true);
          } else {
            const b64 = base64Encode(buffer);
            await send("covers/" + index + "?offset=" + position + "&total=" + length, "PUT", { data: b64 }, false);
          }
        } catch (error) {
          // 解码/尺寸拒绝只跳过当前封面；网络/会话错误结束本次同步。
          if (error.message === "HTTP 422" || error.message === "HTTP 413") { reason = "invalid-cover"; break; }
          throw error;
        }
      }
    }
    if (reason) {
      skipped++;
      await send("skip", "POST", { id: comic.id, reason });
    }
  }
  await send("complete", "POST", { skipped });
  return { fallback: false, skipped };
}
