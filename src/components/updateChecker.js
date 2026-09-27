import app from "@system.app";
import fetch from "./interconnfetch";

const CHECK_INTERVAL = 5 * 60 * 1000;
const FAIL_RETRY_INTERVAL = 60 * 1000;

let lastCheckTime = 0;
let lastCheckOk = false;

function getUpdateUrl() {
  return global.UPDATE_CHECK_URL;
}

function normalizeUpdateInfo(data) {
  if (!data) return null;

  const latestVersionCode = parseInt(
    data.latestVersionCode || data.versionCode || data.latest_code || 0,
    10
  );

  if (!latestVersionCode) return null;

  const current = app.getInfo();
  const currentVersionCode = parseInt(current.versionCode || 0, 10);
  const minSupportedVersionCode = parseInt(
    data.minSupportedVersionCode || data.minVersionCode || data.min_supported_code || 0,
    10
  );
  const needUpdate = latestVersionCode > currentVersionCode;
  const forceUpdate =
    data.force === true ||
    data.forceUpdate === true ||
    (minSupportedVersionCode > 0 && currentVersionCode < minSupportedVersionCode);

  // 强更先于 needUpdate 放行（P1-14）：服务端 force:true 但版本号未递增（同版本强更/
  // 字段配错）或 minSupported 越界时，不再被 needUpdate 门禁吞掉
  if (!needUpdate && !forceUpdate) return null;

  return {
    currentVersionCode: currentVersionCode,
    currentVersionName: current.versionName || "",
    latestVersionCode: latestVersionCode,
    latestVersionName: data.latestVersionName || data.versionName || data.latest_name || "",
    minSupportedVersionCode: minSupportedVersionCode,
    forceUpdate: forceUpdate,
    title: data.title || "",
    message: data.message || "",
    changelog: data.changelog || data.updateContent || data.content || [],
    downloadUrl: data.downloadUrl || data.url || "",
  };
}

export function checkUpdate(force) {
  return new Promise((resolve) => {
    const url = getUpdateUrl();
    if (!url) {
      resolve(null);
      return;
    }

    const now = Date.now();
    const interval = lastCheckOk ? CHECK_INTERVAL : FAIL_RETRY_INTERVAL;
    if (!force && lastCheckTime && now - lastCheckTime < interval) {
      resolve(null);
      return;
    }
    lastCheckTime = now;

    fetch.fetch({
      url: url,
      responseType: "json",
      header: {
        "User-Agent": global.userAgent(),
      },
      success: (response) => {
        lastCheckOk = true;
        const info = normalizeUpdateInfo(response.data);
        // 无更新（含服务端撤回）时写 null 同步清空（P1-14：不再只置不清驱动旧信息）
        global.pendingUpdateInfo = info;
        resolve(info);
      },
      fail: () => {
        lastCheckOk = false;
        // 与"无更新"区分（P1-15 重试出口需要）：调用方按 failed 静默/提示处理
        resolve({ failed: true });
      },
    });
  });
}
