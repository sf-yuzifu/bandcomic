import { gatewayFetch, isNativeFetchSupported } from "./gatewayFetch";
import { safeJsonParse } from "./jsonUtils";
import { updateJsonFile } from "./storage";
import { buildDetailUrl, isComicDetailResponse } from "./api";
import { beginComicImport, commitComicImport, abortComicImport } from "./comicImport";

let bound = null;
let generation = 0;
let active = null;
const completed = [];
let pendingResult = null;

// 使用静态模块名，确保 Vela 打包器可以解析可选系统模块。
function system(name) {
  try {
    if (name === "@system.file") return require("@system.file");
    if (name === "@system.router") return require("@system.router");
    if (name === "@system.prompt") return require("@system.prompt");
  } catch (e) {}
  return null;
}
function toast(message) {
  const prompt = system("@system.prompt");
  if (prompt) prompt.showToast({ message });
}
export function isBound() { return !!bound; }
export function getEndpoint() { return bound && bound.endpoint; }
export function getSessionInfo() { return bound && { ...bound }; }
export function unbind() { generation++; bound = null; }

async function json(url, options = {}) {
  const response = await gatewayFetch({ ...options, url, responseType: "text" });
  if (response.statusCode !== 200) throw new Error("HTTP " + response.statusCode);
  const data = typeof response.data === "string" ? safeJsonParse(response.data, null) : response.data;
  if (!data || typeof data !== "object") throw new Error("Invalid response");
  return data;
}

export async function handleGatewayBind(message, connection) {
  const gen = ++generation;
  const endpoint = (message.endpoint || "").replace(/\/+$/, "");
  const session = message.session || "";
  const reply = (result) => {
    const conn = connection || (global.$hub && global.$hub.getConnection());
    if (conn) conn.send({ data: { type: "gateway_bind_result", session, ...result }, fail() {} });
  };
  try {
    if (!isNativeFetchSupported()) throw new Error("设备不支持原生 fetch");
    if (!/^http:\/\/[^/]+$/.test(endpoint) || !session) throw new Error("绑定参数无效");
    if (active) throw new Error("下载进行中，请完成后重新绑定");
    const health = await json(endpoint + "/control/health");
    if (health.service !== "bandcomic-local-http" ||
        (message.instanceId && health.instanceId !== message.instanceId)) throw new Error("非法的服务标识或实例 ID 不匹配");
    const probe = await gatewayFetch({ url: endpoint + "/control/probe.jpg", responseType: "file" });
    const file = system("@system.file");
    let length = 0;
    try {
      if (probe.statusCode !== 200 || !file || !probe.data) throw new Error("图片探针失败");
      length = await new Promise((resolve, reject) => file.get({ uri: probe.data,
        success: (info) => resolve(info.length || 0), fail: reject }));
      if (!length) throw new Error("图片探针文件为空");
    } finally {
      if (file && probe.data) file.delete({ uri: probe.data, fail() {} });
    }
    if (gen !== generation) return;
    bound = { endpoint, session, instanceId: health.instanceId, boundAt: Date.now() };
    flushPendingResults(endpoint).catch(() => {});
    reply({ success: true, nativeFetch: true, endpoint, instanceId: health.instanceId, probeLength: length });
    toast("本地漫画服务已绑定");
  } catch (e) {
    if (gen === generation) reply({ success: false, nativeFetch: isNativeFetchSupported(), error: String(e.message || e) });
  }
}

// 互联只负责控制；内容与下载 UI 均交给现有下载页面。
export async function handleImportHttpTask(message) {
  const taskId = message.taskId;
  if (!bound || !/^[\w-]+$/.test(taskId || "") ||
      (message.endpoint && message.endpoint !== bound.endpoint)) return;
  if (completed.indexOf(taskId) !== -1 || active) return;
  const context = { ...bound, taskId, savedPages: 0, seen: {}, ended: false, report: Promise.resolve() };
  active = context;
  try {
    const task = await json(context.endpoint + "/control/tasks/" + taskId);
    if (active !== context || !bound || bound.session !== context.session) throw new Error("绑定已失效");
    if (!/^[\w-]+$/.test(task.comicId || "") || !Array.isArray(task.chapters) || !task.chapters.length ||
        !task.chapters.every((c) => Number.isInteger(c.chapterNum) && c.chapterNum > 0 && c.pageCount > 0)) {
      throw new Error("任务章节无效");
    }
    context.task = task;
    context.totalPages = task.chapters.reduce((n, c) => n + c.pageCount, 0);
    context.localId = "local_" + taskId;
    // 按标准漫画源协议准备下载上下文，不将临时服务写入永久源或切换 using。
    const configs = await json(context.endpoint + "/config");
    const source = configs[task.sourceKey || "LocalUpload"];
    if (!source || String(source.apiUrl).replace(/\/+$/, "") !== context.endpoint ||
        ![source.detailPath, source.photoPath].every((path) => typeof path === "string" && /^\/(?!\/)/.test(path)) ||
        !source.detailPath.includes("<id>") || !source.photoPath.includes("<id>") || !source.photoPath.includes("<chapter>")) {
      throw new Error("本地漫画源配置无效");
    }
    context.source = { ...source, apiUrl: context.endpoint };
    const detail = await json(buildDetailUrl(task.comicId, context.source));
    const totalChapters = detail.total_chapters == null ? 1 : Number(detail.total_chapters);
    if (!isComicDetailResponse({ statusCode: 200, data: detail }) || String(detail.item_id) !== task.comicId ||
        !Number.isInteger(totalChapters) || totalChapters < 1 ||
        !task.chapters.every((c) => c.chapterNum <= totalChapters) || typeof detail.cover !== "string" ||
        (detail.cover && !detail.cover.startsWith(context.endpoint + "/"))) {
      throw new Error("本地漫画详情无效");
    }
    context.detail = { ...detail, total_chapters: totalChapters };
    if (task.importChapterProtocol != null) {
      context.transaction = await beginComicImport({ ...task, name: detail.name,
        totalChapters, isSerial: task.isSerial });
      context.localId = context.transaction.stageId;
      if (task.operation === "upsert_chapters" && context.transaction.existing) context.detail.cover = "";
    }
    if (active !== context || !bound || bound.session !== context.session) throw new Error("绑定已失效");
    const router = system("@system.router");
    if (!router) throw new Error("下载页面不可用");
    router.push({ uri: "/pages/download", params: { gatewayTaskId: taskId } });
  } catch (e) {
    finishDownload(context, false, String(e.message || e));
    toast("本地导入准备失败：" + (e.message || e));
  }
}

export function getDownloadContext(taskId) {
  return active && active.taskId === taskId && active.detail ? active : null;
}

export function requestDownload(context, options) {
  if (!options.url.startsWith(context.endpoint + "/")) {
    if (options.fail) options.fail("本地任务 URL 不属于绑定服务", 403);
    return;
  }
  // 只适配原生传输与 JSON 回调，不再重写下载页生成的图片 URL、参数或文件名。
  gatewayFetch({ ...options, responseType: options.responseType === "json" ? "text" : options.responseType,
    success(response) {
      if (options.responseType === "json" && typeof response.data === "string") {
        response.data = safeJsonParse(response.data, null);
      }
      if (options.success) options.success(response);
    },
  }).catch(() => {}); // 回调式页面已由 fail 收口
}

export function pageSaved(context, chapter, page) {
  const key = chapter + "/" + page;
  if (context.ended || context.seen[key]) return;
  context.seen[key] = true;
  context.savedPages++;
  if (context.savedPages % 5 !== 0 && context.savedPages !== context.totalPages) return;
  const count = context.savedPages;
  context.report = context.report.then(() => json(context.endpoint + "/control/tasks/" + context.taskId + "/progress", {
    method: "POST", data: JSON.stringify({ page: count, total: context.totalPages }),
  })).catch(() => {});
}

export async function commitDownload(context) {
  if (context.ended || context.savedPages !== context.totalPages) throw new Error("下载未完整保存");
  if (context.transaction) {
    return commitComicImport(context.transaction, !!context.coverSaved);
  }
  let replaced = [];
  await updateJsonFile("internal://files/comics.json", [], (list) => {
    if (context.ended) throw new Error("任务已取消");
    const current = list.find((c) => c.id === context.localId);
    if (!current) throw new Error("下载索引不存在");
    replaced = list.filter((c) => c.id !== context.localId && c.name === current.name && c.id.startsWith("local_"));
    return list.filter((c) => replaced.indexOf(c) === -1);
  });
  if (!replaced.length) return;
  await updateJsonFile("internal://files/history.json", [], (list) => {
    list.forEach((entry) => {
      if (replaced.some((c) => entry.originalId === c.id || entry.id === "local_" + c.id)) {
        entry.originalId = context.localId;
        entry.id = "local_" + context.localId;
        entry.cover = "internal://files/" + context.localId + "/cover";
        delete entry.coverLocal;
      }
    });
    return list;
  });
  const file = system("@system.file");
  if (file) replaced.forEach((c) => file.rmdir({ uri: "internal://files/" + c.id, recursive: true, fail() {} }));
}

export async function sendResultWithRetry(endpoint, taskId, payload, maxAttempts = 3, initialDelay = 100) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await json(endpoint + "/control/tasks/" + taskId + "/result", {
        method: "POST",
        data: JSON.stringify(payload),
      });
      if (pendingResult && pendingResult.taskId === taskId) {
        pendingResult.reported = true;
      }
      return true;
    } catch (e) {
      console.warn(`导入结果回报失败 (尝试 ${attempt}/${maxAttempts})：` + (e.message || e));
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }
  return false;
}

export function getPendingResult() {
  return pendingResult ? { ...pendingResult } : null;
}

export async function flushPendingResults(endpoint) {
  const target = endpoint || (bound && bound.endpoint);
  if (!target || !pendingResult || pendingResult.reported) return false;
  if (pendingResult.endpoint === target) {
    return sendResultWithRetry(pendingResult.endpoint, pendingResult.taskId, pendingResult.payload, 2, 50);
  }
  return false;
}

export function handleImportHttpQuery(message, connection) {
  const taskId = message && message.taskId;
  const conn = connection || (global.$hub && global.$hub.getConnection());
  if (pendingResult && (!taskId || pendingResult.taskId === taskId)) {
    flushPendingResults(pendingResult.endpoint).catch(() => {});
    if (conn) {
      conn.send({
        data: {
          type: "import_http_result",
          taskId: pendingResult.taskId,
          success: pendingResult.payload.success,
          savedPages: pendingResult.payload.savedPages,
          totalPages: pendingResult.payload.totalPages,
          error: pendingResult.payload.error,
          reported: pendingResult.reported,
        },
        fail() {},
      });
    }
  } else if (conn && taskId) {
    conn.send({
      data: {
        type: "import_http_result_status",
        taskId,
        status: "unknown",
      },
      fail() {},
    });
  }
}

export async function finishDownload(context, success, error) {
  if (!context || context.ended) return;
  context.ended = true;
  if (context.transaction) {
    const tx = context.transaction;
    abortComicImport(tx);
    if (tx.commitPromise) { try { await tx.commitPromise; } catch (e) {} }
    success = tx.committed;
    if (success) error = "";
  }
  if (active === context) active = null;
  completed.push(context.taskId);
  if (completed.length > 32) completed.shift();
  const finalSuccess = !!success && context.savedPages === context.totalPages;
  const payload = {
    success: finalSuccess,
    savedPages: context.savedPages,
    totalPages: context.totalPages || 0,
    error: error || "",
  };
  pendingResult = {
    taskId: context.taskId,
    endpoint: context.endpoint,
    payload,
    reported: false,
    createdAt: Date.now(),
  };
  context.report = context.report
    .then(() => sendResultWithRetry(context.endpoint, context.taskId, payload))
    .catch((e) => console.warn("导入结果回报最终失败：" + (e.message || e)));
  return context.report;
}
