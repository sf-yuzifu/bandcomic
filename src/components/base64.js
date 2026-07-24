const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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
  const lookup = {};
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    lookup[BASE64_CHARS[i]] = i;
  }
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
    const enc1 = lookup[base64.charAt(i)];
    const enc2 = lookup[base64.charAt(i + 1)];
    const enc3 = lookup[base64.charAt(i + 2)];
    const enc4 = lookup[base64.charAt(i + 3)];
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
