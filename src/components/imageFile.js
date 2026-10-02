import file from "@system.file";
import { isFetchTempUri } from "./httpResponse";

const HEADER_BYTES = 32;

export function deleteImageTemp(uri) {
  if (!isFetchTempUri(uri)) return;
  try {
    file.delete({ uri: uri, fail: function () {} });
  } catch (e) {}
}

function u16(bytes, pos) {
  return bytes[pos] | (bytes[pos + 1] << 8);
}

function u32(bytes, pos) {
  return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
}

function matches(bytes, pos, text) {
  for (let i = 0; i < text.length; i++) {
    if (bytes[pos + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

// 只检查文件头/长度，不把整张图读进 JS，也不触发图片解码。
export function isImageHeader(bytes, length, allowLvgl) {
  if (!bytes || bytes.length < 4 || length < 4) return false;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return length > 4;
  if (bytes.length >= 24 && bytes[0] === 0x89 && matches(bytes, 1, "PNG\r\n\x1a\n") &&
      matches(bytes, 12, "IHDR")) {
    return length >= 33 && u32(bytes, 16) !== 0 && u32(bytes, 20) !== 0;
  }
  if (bytes.length >= 10 && (matches(bytes, 0, "GIF87a") || matches(bytes, 0, "GIF89a"))) {
    return length > 13 && u16(bytes, 6) > 0 && u16(bytes, 8) > 0;
  }
  if (matches(bytes, 0, "RIFF") && matches(bytes, 8, "WEBP")) {
    return length >= 20 && u32(bytes, 4) + 8 === length;
  }
  if (bytes.length >= 26 && matches(bytes, 0, "BM")) {
    return length >= 26 && u32(bytes, 2) === length;
  }
  if (!allowLvgl) return false;

  // LVGL 9 使用 12 字节头；支持正常 stride 以及压缩标志，不误当 LVGL 8。
  if (bytes[0] === 0x19 && bytes.length >= 12) {
    const width = u16(bytes, 4), height = u16(bytes, 6), stride = u16(bytes, 8);
    return bytes[1] > 0 && width > 0 && height > 0 && u16(bytes, 10) === 0 &&
      ((u16(bytes, 2) & 8) ? length > 12 : stride > 0 && length >= 12 + stride * height);
  }

  // bandcomic 各源的 LVGL 8：4 字节小端头，cf=10，256 项 BGRA 调色板。
  const header = u32(bytes, 0);
  const cf = header & 31, width = (header >>> 10) & 2047, height = header >>> 21;
  if ((header & 0x3e0) !== 0 || width === 0 || height === 0) return false;
  if (cf >= 7 && cf <= 10) {
    const bits = 1 << (cf - 7);
    const size = 4 + (1 << bits) * 4 + Math.ceil(width * bits / 8) * height;
    return cf === 10 ? length === size : length >= size;
  }
  if (cf >= 11 && cf <= 14) {
    return length >= 4 + Math.ceil(width * (1 << (cf - 11)) / 8) * height;
  }
  // 兼容自建源的普通真彩色/带 alpha 及显式 RGB 格式。
  const pixels = width * height;
  if (cf >= 4 && cf <= 6) {
    const bpp = (length - 4) / pixels;
    return Number.isInteger(bpp) && bpp >= (cf === 5 ? 2 : 1) && bpp <= 4;
  }
  const bpp = { 15: 3, 16: 4, 17: 4, 18: 2, 19: 3, 20: 3 }[cf];
  return !!bpp && length === 4 + pixels * bpp;
}

export function isValidImageFile(uri, allowLvgl, isCurrent) {
  return new Promise((resolve, reject) => {
    const active = () => !isCurrent || isCurrent();
    if (!active()) { resolve(false); return; }
    file.get({
      uri: uri,
      success: (info) => {
        if (!active()) { resolve(false); return; }
        if (info.type === "dir" || !Number.isInteger(info.length) || info.length < 4) {
          resolve(false);
          return;
        }
        file.readArrayBuffer({
          uri: uri,
          position: 0,
          length: Math.min(HEADER_BYTES, info.length),
          success: (data) => {
            if (!active()) { resolve(false); return; }
            const buffer = data && data.buffer;
            const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
            resolve(isImageHeader(bytes, info.length, allowLvgl));
          },
          fail: (data, code) => reject({ data: data, code: code }),
        });
      },
      // 读取失败不是“图片损坏”，不能据此删除或覆盖已有文件。
      fail: (data, code) => reject({ data: data, code: code }),
    });
  });
}
