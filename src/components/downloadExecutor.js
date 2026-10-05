import { isHttpSuccess, createHttpError } from "./httpResponse";
import { isValidImageFile, deleteImageTemp } from "./imageFile";
import { protectTempFile } from "./storage";

let file = null;
try {
  file = require("@system.file");
} catch (e) {
  file = null;
}

export const DOWNLOAD_ABORTED = "download_aborted";

export function createDownloadState(options = {}) {
  return {
    cancelled: false,
    currentRequest: null,
    savedPages: 0,
    totalPages: options.totalPages || 0,
    comicId: options.comicId || "",
    ...options,
  };
}

export function isDownloadActive(state) {
  return !!(state && !state.cancelled);
}

export function cancelDownload(state) {
  if (!state) return;
  state.cancelled = true;
  if (state.currentRequest && typeof state.currentRequest.abort === "function") {
    try {
      state.currentRequest.abort();
    } catch (e) {}
  }
}

/**
 * 校验本地已存在的文件是否为有效图片
 */
export async function hasValidExistingImage(fileUri, allowLvgl, isCurrent) {
  const active = () => !isCurrent || isCurrent();
  if (!active()) return false;

  return new Promise((resolve) => {
    file.get({
      uri: fileUri,
      success: async (info) => {
        if (!active()) {
          resolve(false);
          return;
        }
        if (info.type === "dir" || !Number.isInteger(info.length) || info.length < 4) {
          resolve(false);
          return;
        }
        try {
          const valid = await isValidImageFile(fileUri, allowLvgl, isCurrent);
          if (!active()) {
            resolve(false);
            return;
          }
          if (valid) {
            resolve(true);
            return;
          }
          // 文件存在但已损坏：删除坏文件以便重新下载
          file.delete({
            uri: fileUri,
            success: () => resolve(false),
            fail: () => resolve(false),
          });
        } catch (e) {
          // 读取 I/O 故障而非确认损坏，不误删
          resolve(false);
        }
      },
      fail: () => resolve(false),
    });
  });
}

/**
 * 将下载成功的临时文件校验后 move 到正式目录
 */
export async function saveDownloadedFile(response, fileUri, allowLvgl, state) {
  const tempUri = response && response.data;
  const unprotect = protectTempFile(tempUri);

  if (!isDownloadActive(state)) {
    if (unprotect) unprotect();
    deleteImageTemp(tempUri);
    throw new Error(DOWNLOAD_ABORTED);
  }

  if (!tempUri) {
    if (unprotect) unprotect();
    throw new Error("Empty image response data");
  }

  try {
    if (!isHttpSuccess(response)) {
      throw createHttpError(response);
    }

    const valid = await isValidImageFile(tempUri, allowLvgl, () => isDownloadActive(state));
    if (!isDownloadActive(state)) {
      throw new Error(DOWNLOAD_ABORTED);
    }
    if (!valid) {
      throw new Error("Corrupted downloaded image format");
    }

    await new Promise((resolve, reject) => {
      file.move({
        srcUri: tempUri,
        dstUri: fileUri,
        success: () => resolve(),
        fail: (data, code) => {
          deleteImageTemp(tempUri);
          reject(new Error("Move file failed with code: " + code));
        },
      });
    });
  } catch (e) {
    deleteImageTemp(tempUri);
    throw e;
  } finally {
    if (unprotect) unprotect();
  }
}

/**
 * 串行下载单张图片并支持失败重试
 */
export async function downloadSingleImage(options) {
  const {
    url,
    fileUri,
    allowLvgl = false,
    fetchFn,
    state,
    maxRetries = 3,
  } = options;

  if (!isDownloadActive(state)) {
    throw new Error(DOWNLOAD_ABORTED);
  }

  // 1. 检查本地是否已有有效图片
  const exists = await hasValidExistingImage(fileUri, allowLvgl, () => isDownloadActive(state));
  if (!isDownloadActive(state)) {
    throw new Error(DOWNLOAD_ABORTED);
  }
  if (exists) {
    return { skipped: true };
  }

  // 2. 带重试的下载循环
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!isDownloadActive(state)) {
      throw new Error(DOWNLOAD_ABORTED);
    }

    try {
      const response = await fetchFn({
        url: url,
        responseType: "file",
      });

      if (!isDownloadActive(state)) {
        deleteImageTemp(response && response.data);
        throw new Error(DOWNLOAD_ABORTED);
      }

      await saveDownloadedFile(response, fileUri, allowLvgl, state);
      return { skipped: false, fileUri: fileUri };
    } catch (err) {
      const normalizedErr =
        err instanceof Error
          ? err
          : new Error(
              (err && (err.message || err.data)) ||
                "Download error: " + JSON.stringify(err)
            );
      lastError = normalizedErr;
      if (
        normalizedErr.noRetry ||
        [400, 401, 403, 404, 409, 413, 429, 503].indexOf(Number(err && (err.httpStatus || err.code))) !== -1 ||
        normalizedErr.message === DOWNLOAD_ABORTED ||
        normalizedErr.message.includes("Corrupted")
      ) {
        throw normalizedErr;
      }
      if (attempt < maxRetries && isDownloadActive(state)) {
        // 短暂退避重试
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error("Download failed after retries");
}
