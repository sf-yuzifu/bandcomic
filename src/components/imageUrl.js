export function addUrlParam(url, key, value) {
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const baseUrl = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

  try {
    const urlObj = new URL(baseUrl);
    urlObj.searchParams.set(key, value.toString());
    return urlObj.toString() + hash;
  } catch (error) {
    if (baseUrl.includes("?" + key + "=") || baseUrl.includes("&" + key + "=")) {
      return baseUrl + hash;
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
  return addImageParams(url, 80, parseInt(global.APP_SETTING.imageQuality) || 50);
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
