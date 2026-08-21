import { proxyImage } from "./api";

// 列表封面代理加载：不支持直接加载远程图片的设备，经插件把封面拉为本地文件后，
// 用 splice 原地替换列表项触发界面刷新（回调时列表可能已翻页，靠 match 重新定位）
// options:
//   getUrl(item)            封面请求地址（空或非 http 开头跳过）
//   getName(item)           本地文件命名
//   match(row, item)        回调时重新定位列表项
//   merge(item, uri)        生成替换用的新对象
//   skipSame                为 true 时代理返回原地址（直连设备）不替换
//   onLocal(item, updated)  替换成功后的额外回调（如同步更新缓存列表）
export function loadCoverProxies(list, options) {
  list.forEach((item) => {
    const url = options.getUrl(item);
    if (!url || url.indexOf("http") !== 0) return;
    proxyImage(
      url,
      options.getName(item),
      (uri) => {
        if (!uri || (options.skipSame && uri === url)) return;
        const updated = options.merge(item, uri);
        const index = list.findIndex((row) => options.match(row, item));
        if (index === -1) return;
        list.splice(index, 1, updated);
        if (options.onLocal) {
          options.onLocal(item, updated);
        }
      },
      1
    );
  });
}
