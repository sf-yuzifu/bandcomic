// 设备兼容分级（与 README 适配表对齐，供快速检查页使用）
// 键名 = 真机 deviceRet.product 实测值（精确查表，两表键名必须一致，P0-14）
const FULL_SUPPORT_PRODUCTS = [
  "Xiaomi Smart Band 9 Pro",
  "Xiaomi Watch S3",
  "Xiaomi Watch S3 eSIM",
  "Xiaomi Watch S4",
  "Xiaomi Watch S4 eSIM",
  "Xiaomi Watch S4 Sport",
  "Xiaomi Watch S4 41mm",
  "Xiaomi Watch S5 46mm",
  "Xiaomi Watch S5 eSIM 46mm",
  "REDMI Watch 5",
  "REDMI Watch 6",
  "marconi_o62m_watch",
  "o65m",
];

const BRIDGE_ONLY_PRODUCTS = ["Xiaomi Smart Band 10 Pro"];

const UNSUPPORTED_PRODUCTS = [
  "Xiaomi Smart Band 9",
  "Xiaomi Smart Band 10",
  "Xiaomi Smart Band 8 Pro",
  "Redmi Watch 4",
];

// ok=完全适配 | needBridge=需网桥 | unsupported=明确不支持
// notRecommended=跑道屏未列适配（强警示）| unknown=其他未列型号（弱警告）
export function getDeviceSupportLevel(product, screenShape) {
  if (FULL_SUPPORT_PRODUCTS.indexOf(product) !== -1) return "ok";
  if (BRIDGE_ONLY_PRODUCTS.indexOf(product) !== -1) return "needBridge";
  if (UNSUPPORTED_PRODUCTS.indexOf(product) !== -1) return "unsupported";
  if (screenShape === "pill-shaped") return "notRecommended";
  return "unknown";
}

export const DEVICE_RESERVED_SPACE = {
  "Xiaomi Smart Band 9 Pro": 64 * 1024 * 1024,
  "Xiaomi Watch S3": 1024 * 1024 * 1024,
  "Xiaomi Watch S3 eSIM": 1024 * 1024 * 1024,
  "Xiaomi Watch S4": 1024 * 1024 * 1024,
  "Xiaomi Watch S4 eSIM": 1024 * 1024 * 1024,
  "Xiaomi Watch S5 46mm": 1024 * 1024 * 1024,
  "Xiaomi Watch S5 eSIM 46mm": 1024 * 1024 * 1024,
  "Xiaomi Watch S4 Sport": 1024 * 1024 * 1024,
  marconi_o62m_watch: 1024 * 1024 * 1024,
  "Xiaomi Watch S4 41mm": 1024 * 1024 * 1024,
  "REDMI Watch 5": 120 * 1024 * 1024,
  o65m: 1024 * 1024 * 1024,
  "REDMI Watch 6": 120 * 1024 * 1024,
};
