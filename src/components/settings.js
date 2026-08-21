// 全局设置项（global.APP_SETTING）的读取入口

// 列表分页大小，跟随设置项 searchPageSize
export function getSearchPageSize() {
  return parseInt(global.APP_SETTING.searchPageSize, 10) || 10;
}
