import { safeJsonParse } from "./jsonUtils";

// interconnect 单例连接的唯一持有者 + 消息分发层。
// 背景：@system.interconnect.instance() 是单例，dataBridge（type 命名空间）
// 与 interconnfetch（tag 命名空间）曾各自赋值 conn.onmessage 互相覆盖，
// 后挂载者会截断前者的全部消息（fetch 分片甚至会落入 dataBridge 的 Cookie 兜底）。
// 现在只允许本模块触碰 onmessage，按命名空间路由：
//   - 含 tag 字段的 JSON → 网桥 fetch 协议（interconnfetch）
//   - 其余（含 type 的 JSON、非 JSON 文本）→ 数据桥（dataBridge；无法识别的消息会被丢弃并记日志）

let interconnectModule = null;
try {
  interconnectModule = require("@system.interconnect");
} catch (e) {
  interconnectModule = null;
}

let conn = null;
let fetchHandler = null; // (parsedMsg) => void，tag 命名空间
let bridgeHandler = null; // (rawEvent) => void，type 命名空间 + 非 JSON 兜底
let activityHandler = null; // () => void，任意消息到达通知（网桥保活）

function dispatch(event) {
  if (activityHandler) {
    activityHandler();
  }
  const data = event && event.data;
  const parsed = typeof data === "string" ? safeJsonParse(data, null) : null;
  if (parsed && parsed.tag) {
    if (fetchHandler) {
      fetchHandler(parsed);
    }
    return;
  }
  if (bridgeHandler) {
    bridgeHandler(event);
  }
}

// 获取单例连接；首次调用时装上唯一的消息分发器。
// 无 interconnect 能力或实例获取失败时返回 null。
export function getConnection() {
  if (conn) return conn;
  if (!interconnectModule) return null;
  try {
    conn = interconnectModule.instance();
  } catch (e) {
    return null;
  }
  if (conn) {
    conn.onmessage = dispatch;
  }
  return conn;
}

// 网桥 fetch 协议消息（__hs__/fetch/fetch-chunk 等 tag 消息）
export function registerFetchHandler(fn) {
  fetchHandler = fn;
}

// 数据桥消息（hs_ping/source_config/cookie/import_comic_* 等 type 消息及非 JSON）
export function registerBridgeHandler(fn) {
  bridgeHandler = fn;
}

// 任意消息到达时的通知（用于重置网桥空闲计时器）
export function registerActivityHandler(fn) {
  activityHandler = fn;
}
