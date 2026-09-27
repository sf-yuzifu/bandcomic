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

// 并发上限（P2-32）：网桥设备上一次性灌满请求队列会让先入队的封面占满通道，
// 分批补位（3 个一档）即可，封面是后台低优先级请求
const COVER_CONCURRENCY = 3;

export function loadCoverProxies(list, options) {
  let next = 0;
  let active = 0;

  function settle(item, index, url, uri) {
    active--;
    if (uri && !(options.skipSame && uri === url)) {
      const updated = options.merge(item, uri);
      // 索引快照优先（splice 原位替换不改下标）；列表被外部重建时退回 match 重定位
      let target = index;
      if (!list[target] || !options.match(list[target], item)) {
        target = list.findIndex((row) => options.match(row, item));
      }
      if (target !== -1) {
        list.splice(target, 1, updated);
        if (options.onLocal) {
          options.onLocal(item, updated);
        }
      }
    }
    pump();
  }

  function pump() {
    while (active < COVER_CONCURRENCY && next < list.length) {
      const index = next++;
      const item = list[index];
      const url = options.getUrl(item);
      if (!url || url.indexOf("http") !== 0) continue;
      active++;
      proxyImage(
        url,
        options.getName(item),
        (uri) => {
          settle(item, index, url, uri);
        },
        1
      );
    }
  }

  pump();
}
