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
  );

  if (!latestVersionCode) return null;

  const current = app.getInfo();
  const currentVersionCode = parseInt(current.versionCode || 0);
  const minSupportedVersionCode = parseInt(
    data.minSupportedVersionCode ||
      data.minVersionCode ||
      data.min_supported_code ||
      0,
  );
  const needUpdate = latestVersionCode > currentVersionCode;
  const forceUpdate =
    data.force === true ||
    data.forceUpdate === true ||
    (minSupportedVersionCode > 0 &&
      currentVersionCode < minSupportedVersionCode);

  if (!needUpdate) return null;

  return {
    currentVersionCode: currentVersionCode,
    currentVersionName: current.versionName || "",
    latestVersionCode: latestVersionCode,
    latestVersionName:
      data.latestVersionName || data.versionName || data.latest_name || "",
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
        if (info) {
          global.pendingUpdateInfo = info;
        }
        resolve(info);
      },
      fail: () => {
        lastCheckOk = false;
        resolve(null);
      },
    });
  });
}
