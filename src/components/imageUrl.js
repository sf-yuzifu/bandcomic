export function addUrlParam(url, key, value) {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const baseUrl = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set(key, value.toString());
    return urlObj.toString() + hash;
  } catch (error) {
    // key 已存在：原位替换其值（到 & 或结尾），与 try 分支 searchParams.set 的更新语义一致
    const qMark = "?" + key + "=";
    const aMark = "&" + key + "=";
    let idx = baseUrl.indexOf(qMark);
    let markLen = qMark.length;
    if (idx < 0) {
      idx = baseUrl.indexOf(aMark);
      markLen = aMark.length;
    }
    if (idx >= 0) {
      const valueStart = idx + markLen;
      let valueEnd = baseUrl.indexOf("&", valueStart);
      if (valueEnd < 0) valueEnd = baseUrl.length;
      return (
        baseUrl.slice(0, valueStart) + encodeURIComponent(value) + baseUrl.slice(valueEnd) + hash
      );
    }
    const separator = baseUrl.includes("?") ? "&" : "?";
    return baseUrl + separator + key + "=" + encodeURIComponent(value) + hash;
  }
}

export function addImageParams(url, width = 600, quality = 50, params = ["width", "quality"]) {
  let result = addUrlParam(url, params[0], width);
  result = addUrlParam(result, params[1], quality);
  if (global.APP_SETTING.imageUsePng) {
    result = addUrlParam(result, "ifPNG", 1);
  }
  return result;
}

export function addCoverParams(url) {
  return addImageParams(url, 80, parseInt(global.APP_SETTING.imageQuality, 10) || 50);
}

export function appendLvglSuffix(url, suffix) {
  let result = url;
  if (global.APP_SETTING.imagePreTranscode) {
    result = addUrlParam(result, "ifLVGL", 1);
  }
  // 通过 "#/文件名" 让固件按斜杠分段取临时文件名时拿到干净的名字，
  // 避免 query 里的 ? & = 等字符进入临时文件名导致系统异常
  const ext = global.APP_SETTING.imagePreTranscode
    ? ".bin"
    : global.APP_SETTING.imageUsePng
      ? ".png"
      : ".jpg";
  const safeName = String(suffix).replace(/[^\w.-]+/g, "_");
  return result + "#/" + safeName + ext;
}
