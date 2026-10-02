import file from "@system.file";
import { proxyImage } from "./api";

// 列表封面代理加载：不支持直接加载远程图片的设备，经插件把封面拉为本地文件后，
// 用 splice 原地替换列表项触发界面刷新
// options:
//   getUrl(item)            封面请求地址（空或非 http 开头跳过）
//   getName(item)           本地文件命名
//   match(row, item)        回调时重新定位列表项
//   merge(item, uri)        生成替换用的新对象
//   skipSame                为 true 时代理返回原地址（直连设备）不替换
//   onLocal(item, updated)  替换成功后的额外回调（如同步更新缓存列表）

// Share one in-flight cover proxy across search and history pages; watch network
// work is serialized even when a stale batch is still completing.
const waitingBatches = [];
let activeProxy = null;

function deleteProxyTemp(uri) {
  if (typeof uri !== "string" || uri.indexOf("internal://files/_icf_") !== 0) return;
  try {
    file.delete({ uri: uri, fail: function () {} });
  } catch (e) {}
}

function nextCover(batch) {
  while (batch.list && batch.next < batch.list.length) {
    const index = batch.next++;
    const item = batch.list[index];
    const url = batch.options.getUrl(item);
    if (!url || url.indexOf("http") !== 0) continue;
    return { index: index, item: item, url: url };
  }
  batch.completed = true;
  batch.list = null;
  batch.options = null;
  return null;
}

function scheduleBatch(batch) {
  if (batch.cancelled || batch.completed || batch.queued) return;
  if (activeProxy && activeProxy.batch === batch) return;
  batch.queued = true;
  waitingBatches.push(batch);
  pumpQueue();
}

function settleCover(batch, cover, uri) {
  const list = batch.list;
  const options = batch.options;
  try {
    if (uri && !(options.skipSame && uri === cover.url)) {
      const updated = options.merge(cover.item, uri);
      // Prefer the captured index; fall back to matching after list replacement.
      let target = cover.index;
      if (!list[target] || !options.match(list[target], cover.item)) {
        target = list.findIndex((row) => options.match(row, cover.item));
      }
      if (target !== -1) {
        list.splice(target, 1, updated);
        if (options.onLocal) options.onLocal(cover.item, updated);
      }
    }
  } finally {
    scheduleBatch(batch);
  }
}

function pumpQueue() {
  if (activeProxy) return;

  while (waitingBatches.length > 0) {
    const batch = waitingBatches.shift();
    batch.queued = false;
    if (batch.cancelled || batch.completed) continue;

    const cover = nextCover(batch);
    if (!cover) continue;

    const request = { batch: batch, cover: cover };
    activeProxy = request;
    let settled = false;
    const finish = (uri) => {
      if (settled) return;
      settled = true;
      if (activeProxy === request) activeProxy = null;

      if (batch.cancelled) {
        deleteProxyTemp(uri);
      } else {
        settleCover(batch, cover, uri);
      }
      pumpQueue();
    };

    try {
      const sourceKey =
        typeof batch.options.getSourceKey === "function"
          ? batch.options.getSourceKey(cover.item)
          : cover.item && cover.item.source;
      proxyImage(cover.url, batch.options.getName(cover.item), finish, 1, sourceKey);
    } catch (e) {
      finish("");
    }
    return;
  }
}

export function loadCoverProxies(list, options) {
  const batch = {
    list: list,
    options: options,
    next: 0,
    queued: false,
    cancelled: false,
    completed: false,
  };

  scheduleBatch(batch);

  return function cancel() {
    if (batch.cancelled || batch.completed) return;
    batch.cancelled = true;
    batch.completed = true;
    batch.list = null;
    batch.options = null;
    if (batch.queued) {
      const index = waitingBatches.indexOf(batch);
      if (index !== -1) waitingBatches.splice(index, 1);
      batch.queued = false;
    }
  };
}
