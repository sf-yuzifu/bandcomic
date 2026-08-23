const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// 解码查表：模块级惰性单例（此前每次调用都重建 64 项对象，分片场景每片白建一次）；
// Int8Array 越界访问返回 undefined，与旧对象查表对非法字符的语义一致（调用前已正则清洗）
let B64_LOOKUP = null;
function getLookup() {
  if (!B64_LOOKUP) {
    B64_LOOKUP = new Int8Array(128).fill(-1);
    for (let i = 0; i < BASE64_CHARS.length; i++) {
      B64_LOOKUP[BASE64_CHARS.charCodeAt(i)] = i;
    }
  }
  return B64_LOOKUP;
}

export function base64Encode(input) {
  const bytes = new Uint8Array(input);
  const len = bytes.length;
  let result = "";
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    result += BASE64_CHARS[b1 >> 2];
    result += BASE64_CHARS[((b1 & 3) << 4) | (b2 >> 4)];
    result += i + 1 < len ? BASE64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : "=";
    result += i + 2 < len ? BASE64_CHARS[b3 & 63] : "=";
  }
  return result;
}

export function base64ToBytes(base64) {
  const lookup = getLookup();
  base64 = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const len = base64.length;
  let padding = 0;
  if (len > 0 && base64.charAt(len - 1) === "=") padding++;
  if (len > 1 && base64.charAt(len - 2) === "=") padding++;
  let bufLen = Math.floor((len * 3) / 4 - padding);
  if (bufLen < 0) bufLen = 0;
  const bytes = new Uint8Array(bufLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const enc1 = lookup[base64.charCodeAt(i)];
    const enc2 = lookup[base64.charCodeAt(i + 1)];
    const enc3 = lookup[base64.charCodeAt(i + 2)];
    const enc4 = lookup[base64.charCodeAt(i + 3)];
    bytes[p++] = (enc1 << 2) | (enc2 >> 4);
    if (base64.charAt(i + 2) !== "=") {
      bytes[p++] = ((enc2 & 15) << 4) | (enc3 >> 2);
    }
    if (base64.charAt(i + 3) !== "=") {
      bytes[p++] = ((enc3 & 3) << 6) | enc4;
    }
  }
  return bytes;
}
