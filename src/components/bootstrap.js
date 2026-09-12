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
    if (global.applyDeviceRecommendedSettings) {
      global.applyDeviceRecommendedSettings();
    }
    mergeSourcesToGlobal(Array.isArray(sources) ? sources : []);
    global.cookie = cookie || {};
    if (global.APP_SETTING.oobeDone) {
      return { skipOobe: true };
    }
    // 存量用户升级：已有 settings 则静默补写，不打断
    if (hadExisting) {
      global.APP_SETTING.oobeDone = true;
      writeSettings(global.APP_SETTING).catch(function () {});
      return { skipOobe: true };
    }
    return { skipOobe: false };
  });
}
