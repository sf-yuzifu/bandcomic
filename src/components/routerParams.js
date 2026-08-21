export function serializeParams(params) {
  const result = {};
  for (const key in params) {
    const value = params[key];
    if (value !== null && typeof value === "object") {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function parseParam(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  // 与 serializeParams 对称：它只对 object 做 JSON.stringify（产物必以 { 或 [ 开头），
  // 其余值原样直存；这里只解析 {/[ 开头的字符串，
  // "123"/"true" 等数字/布尔外观的字符串保持原样，往返不改变类型
  const first = value.charAt(0);
  if (first !== "{" && first !== "[") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

export function parseParams(params) {
  const result = {};
  for (const key in params) {
    result[key] = parseParam(params[key]);
  }
  return result;
}
