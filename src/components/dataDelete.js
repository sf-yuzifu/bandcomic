import file from "@system.file";
import { readComics, updateJsonFile, COMICS_URI, SOURCES_URI, FILE_ERROR, acquireComicMutation } from "./storage";
import { ensureUsingSourceValid } from "./api";

export const DELETE_PROTOCOL = 1;
const MAX_DELETE_RECORDS = 32;

function failure(code, message, extra = {}) {
  return { status: "failed", filesState: "unknown", indexState: "retained", code, message, ...extra };
}

export function validComicId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 512 &&
    id !== "." && id !== ".." && !/[\\/]/.test(id) &&
    !Array.from(id).some((character) => character.charCodeAt(0) < 32);
}

function io(method, options) {
  return new Promise((resolve, reject) => {
    file[method]({ ...options, success: resolve, fail: (data, code) => reject({ data, code }) });
  });
}

async function removeDirectory(uri, fallback) {
  try {
    await io("access", { uri });
  } catch (error) {
    if (error.code === FILE_ERROR.NOT_FOUND) return "missing";
    throw error;
  }
  try {
    await io("rmdir", { uri, recursive: true });
  } catch (error) {
    if (error.code === FILE_ERROR.NOT_FOUND) return "missing";
    if (!fallback) throw error;
    const info = await io("get", { uri, recursive: true });
    const files = [];
    const collect = (entries) => entries.forEach((entry) => {
      if (entry.type === "dir") collect(entry.subFiles || []);
      else files.push(entry.uri);
    });
    collect(info.subFiles || []);
    let removed = 0;
    let failed = 0;
    for (const path of files) {
      try { await io("delete", { uri: path }); removed++; }
      catch (e) { if (e.code !== FILE_ERROR.NOT_FOUND) failed++; }
    }
    if (failed) throw { code: "FILES_DELETE_FAILED", partial: removed > 0 };
    try { await io("rmdir", { uri, recursive: true }); }
    catch (e) {
      // Only NOT_FOUND proves absence. Other access failures retain the index.
      try { await io("access", { uri }); }
      catch (accessError) { if (accessError.code === FILE_ERROR.NOT_FOUND) return "removed"; throw accessError; }
      throw { code: e.code, partial: removed > 0 };
    }
  }
  return "removed";
}

export async function deleteComicById(id, options = {}) {
  if (!validComicId(id)) return failure("INVALID_TARGET", "漫画 ID 无效");
  const lease = acquireComicMutation(id);
  if (!lease) return failure("TARGET_BUSY", "该漫画正在下载、导入或删除，请稍后重试");
  let name = "";
  try {
    let list;
    try { list = await readComics(true); }
    catch (e) { return failure("INDEX_READ_FAILED", "读取漫画索引失败", { ioCode: e.code }); }
    if (!Array.isArray(list)) return failure("INDEX_INVALID", "漫画索引格式无效");
    const targets = list.filter((c) => c && c.id === id);
    if (targets.length !== 1) return failure(targets.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND", "未找到唯一漫画条目，请重新读取");
    const target = targets[0];
    name = target.name || id;
    const fingerprint = JSON.stringify(target);
    let filesState;
    try { filesState = await removeDirectory("internal://files/" + target.id + "/", options.fallback); }
    catch (e) {
      return failure("FILES_DELETE_FAILED", "删除失败，请重试", {
        status: e.partial ? "partial" : "failed", name, ioCode: e.code,
      });
    }
    try {
      await updateJsonFile(COMICS_URI, [], (current) => {
        if (!Array.isArray(current)) throw new Error("Invalid comic index");
        const matches = current.filter((c) => c && c.id === id);
        if (matches.length !== 1 || JSON.stringify(matches[0]) !== fingerprint) throw new Error("Comic changed during deletion");
        return current.filter((c) => !c || c.id !== id);
      }, { requireValid: true });
    } catch (e) {
      return failure("INDEX_WRITE_FAILED", "文件已删除，但索引更新失败", {
        status: "partial", filesState, name, ioCode: e.code,
      });
    }
    return { status: "success", filesState, indexState: "removed", code: "DELETED", name, message: "已删除: " + name };
  } finally {
    lease.release();
  }
}

export async function deleteSourceByKey(key) {
  if (typeof key !== "string" || !key || key.length > 512 || key === "using") return failure("INVALID_TARGET", "漫画源 key 无效");
  let name = key;
  try {
    await updateJsonFile(SOURCES_URI, [], (list) => {
      if (!Array.isArray(list) || list.some((s) => !s || typeof s !== "object" || Object.keys(s).length !== 1)) throw new Error("Invalid sources");
      const targets = list.filter((s) => Object.keys(s)[0] === key);
      if (targets.length !== 1) throw { targetMissing: true };
      name = (targets[0][key] && targets[0][key].name) || key;
      return list.filter((s) => Object.keys(s)[0] !== key);
    }, { requireValid: true });
  } catch (e) {
    return failure(e.targetMissing ? "TARGET_NOT_FOUND" : "INDEX_WRITE_FAILED",
      e.targetMissing ? "未找到唯一漫画源，请重新读取" : "删除失败，请重试", { filesState: "not_applicable", ioCode: e.code });
  }
  try {
    delete global.API_SETTING[key];
    ensureUsingSourceValid();
  } catch (e) {
    return failure("MEMORY_UPDATE_FAILED", "配置已删除，但当前源更新失败，请重新打开应用核实", {
      status: "partial", indexState: "removed", filesState: "not_applicable", name,
    });
  }
  return { status: "success", indexState: "removed", filesState: "not_applicable", code: "DELETED", name, message: "已删除漫画源: " + name };
}

// Injectable controller used by the real bridge and protocol tests. Records survive
// bridge recreation/refresh, but never claim durable exactly-once across app restarts.
export function createDeleteController(execute) {
  let session = "";
  const records = new Map();
  const trim = () => {
    for (const [id, record] of records) {
      if (records.size < MAX_DELETE_RECORDS) break;
      if (record.session !== session && record.result.status !== "processing") records.delete(id);
    }
  };
  const identity = (msg) => msg.kind === "comic" ? msg.comicId : msg.sourceKey;
  const same = (record, msg, requestSession) => record.session === requestSession && record.kind === msg.kind && record.target === identity(msg);
  const envelope = (msg, requestSession, result) => ({
    type: "delete_result", protocol: DELETE_PROTOCOL, session: requestSession,
    requestId: msg.requestId, kind: msg.kind,
    ...(msg.kind === "comic" ? { comicId: msg.comicId } : { sourceKey: msg.sourceKey }), ...result,
  });
  return {
    beginSession(value) { session = typeof value === "string" ? value : ""; trim(); },
    handle(msg, send) {
      const query = msg.type === "delete_status";
      const requestSession = query ? msg.requestSession : msg.session;
      const requestError = (code, message) => failure(code, message, query ? { status: "unknown", indexState: "unknown" } : {});
      if (msg.protocol !== DELETE_PROTOCOL || typeof msg.requestId !== "string" || !/^[\w-]{1,128}$/.test(msg.requestId) ||
          typeof requestSession !== "string" || !requestSession || requestSession.length > 128 ||
          !["comic", "source"].includes(msg.kind) ||
          (msg.kind === "comic" ? !validComicId(msg.comicId) : typeof msg.sourceKey !== "string" || !msg.sourceKey || msg.sourceKey.length > 512 || msg.sourceKey === "using")) {
        send(envelope(msg, requestSession, requestError("INVALID_REQUEST", "删除请求参数无效")));
        return;
      }
      const existing = records.get(msg.requestId);
      if (existing && !same(existing, msg, requestSession)) {
        send(envelope(msg, requestSession, requestError("REQUEST_CONFLICT", "请求 ID 对应另一目标")));
        return;
      }
      // Queries need a current connection; execution duplicates may replay the old
      // result. Evicted requests cannot execute again through their retired session.
      if ((!existing || query) && (!session || msg.session !== session)) {
        send(envelope(msg, requestSession, requestError("SESSION_EXPIRED", "删除会话已失效，请重新读取")));
        return;
      }
      if (existing) { send(envelope(msg, requestSession, existing.result)); return; }
      if (query) {
        send(envelope(msg, requestSession, { status: "unknown", code: "RESULT_UNKNOWN", filesState: "unknown", indexState: "unknown", message: "设备没有此请求的结果，请重新读取核实" }));
        return;
      }
      trim();
      if (records.size >= MAX_DELETE_RECORDS) {
        send(envelope(msg, requestSession, failure("REQUEST_LIMIT", "删除请求记录已满，请重新握手")));
        return;
      }
      const record = { session: requestSession, kind: msg.kind, target: identity(msg),
        result: { status: "processing", filesState: "unknown", indexState: "unknown", code: "DELETING", message: "设备正在删除" } };
      records.set(msg.requestId, record); // before any asynchronous work
      Promise.resolve().then(() => execute(msg)).catch(() => failure("DELETE_ERROR", "设备删除异常，请重新读取核实", { status: "unknown", indexState: "unknown" }))
        .then((result) => { record.result = result; send(envelope(msg, requestSession, result)); });
    },
  };
}

export const deviceDeletes = createDeleteController((msg) => msg.kind === "comic"
  ? deleteComicById(msg.comicId) : deleteSourceByKey(msg.sourceKey));
