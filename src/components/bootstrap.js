// 冷启动数据引导：读 settings/sources/cookie，判断是否跳过 OOBE
// entry 为启动页时由它调用；OOBE/首页不再各自抢跑读盘
import { readSettings, readSources, readCookie, writeSettings } from "./storage";
import { mergeSourcesToGlobal } from "./api";

export function bootstrapAppData() {
  return Promise.all([
    readSettings().then(
      (d) => d,
      () => ({})
    ),
    readSources().then(
      (d) => d,
      () => []
    ),
    readCookie().then(
      (c) => c,
      () => ({})
    ),
  ]).then(function (parts) {
    const settings = parts[0] || {};
    const sources = parts[1] || [];
    const cookie = parts[2] || {};
    const hadExisting = !!(
      settings &&
      typeof settings === "object" &&
      Object.keys(settings).length > 0
    );
    global.APP_SETTING = Object.assign(global.APP_SETTING, settings);
    // 路由判定先于合并操作算好（P0-12）：合并失败降级时与正常路径同一规则——
    // 有数据（oobeDone || hadExisting）进首页，真什么都没设置才进 OOBE
    const skipOobe = !!(global.APP_SETTING.oobeDone || hadExisting);
    global.cookie = cookie || {};
    let failed = false;
    try {
      if (global.applyDeviceRecommendedSettings) {
        global.applyDeviceRecommendedSettings();
      }
      mergeSourcesToGlobal(Array.isArray(sources) ? sources : []);
    } catch (e) {
      // 合并异常不阻断启动（P0-12）：按上面的路由降级继续，failed 供启动页提示
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
