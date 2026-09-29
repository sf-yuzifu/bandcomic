// 冷启动数据引导：读 settings/sources/cookie，判断是否跳过 OOBE
// entry 为启动页时由它调用；OOBE/首页不再各自抢跑读盘
import { FILE_ERROR, readSettings, readSources, readCookie, writeSettings } from "./storage";
import { mergeSourcesToGlobal, ensureUsingSourceValid } from "./api";

function applyStartupValue(key, value, fallback, apply, ready, failed) {
  const data = value == null ? fallback : value;
  try {
    apply(data);
    global.bootstrapDataStatus[key] = ready;
    return { data: data, ready: ready, failed: failed };
  } catch (error) {
    try {
      apply(fallback);
    } catch (fallbackError) {}
    global.bootstrapDataStatus[key] = false;
    return { data: fallback, ready: false, failed: true };
  }
}

function readStartupFile(key, read, fallback, apply) {
  let request;
  try {
    request = read();
  } catch (error) {
    request = Promise.reject(error);
  }

  return Promise.resolve(request).then(
    (value) => applyStartupValue(key, value, fallback, apply, true, false),
    (error) => {
      const missing = error && error.code === FILE_ERROR.NOT_FOUND;
      return applyStartupValue(key, fallback, fallback, apply, !!missing, !missing);
    }
  );
}

export function bootstrapAppData() {
  // Publish each file's readiness as soon as it settles. If another read hangs and
  // boot times out, index can reuse completed data and retry only the unfinished files.
  global.bootstrapDataStatus = {
    settings: false,
    sources: false,
    cookie: false,
  };

  return Promise.all([
    readStartupFile("settings", readSettings, {}, (settings) => {
      global.APP_SETTING = Object.assign(global.APP_SETTING, settings);
      if (global.applyDeviceRecommendedSettings) {
        global.applyDeviceRecommendedSettings();
      }
    }),
    readStartupFile("sources", readSources, [], (sources) => {
      mergeSourcesToGlobal(Array.isArray(sources) ? sources : []);
      ensureUsingSourceValid();
    }),
    readStartupFile("cookie", readCookie, {}, (cookie) => {
      global.cookie = cookie || {};
    }),
  ]).then(function (parts) {
    const settings = parts[0].data || {};
    const hadExisting = !!(
      settings &&
      typeof settings === "object" &&
      Object.keys(settings).length > 0
    );
    // 路由判定先于合并操作算好（P0-12）：合并失败降级时与正常路径同一规则——
    // 有数据（oobeDone || hadExisting）进首页，真什么都没设置才进 OOBE；
    // 无法读取设置时不能确认这是首启，按有数据降级进首页。
    const skipOobe = !!(
      global.APP_SETTING.oobeDone ||
      hadExisting ||
      !parts[0].ready
    );
    let failed = parts.some((part) => part.failed);
    try {
      if (global.applyDeviceRecommendedSettings) {
        global.applyDeviceRecommendedSettings();
      }
      ensureUsingSourceValid();
    } catch (e) {
      // 应用推荐设置异常不阻断启动（P0-12）：failed 供启动页提示
      failed = true;
      console.error("bootstrapAppData merge failed: " + e);
    }
    if (skipOobe && hadExisting && !global.APP_SETTING.oobeDone) {
      // 存量用户升级：已有 settings 则静默补写，不打断
      global.APP_SETTING.oobeDone = true;
      writeSettings(global.APP_SETTING).catch(function () {});
    }
    return { skipOobe: skipOobe, failed: failed };
  });
}
