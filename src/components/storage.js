import file from "@system.file";

// 快应用 file API 错误码
export const FILE_ERROR = {
  // 通用 I/O 错误（如存储空间不足）
  IO_ERROR: 300,
  // 文件/目录不存在
  NOT_FOUND: 301,
  // 目录已存在（老版快应用 SDK）
  ALREADY_EXISTS: 202,
  // 目录已存在（新版 Vela SDK，OHOS 风格错误码）
  ALREADY_EXISTS_NEW_SDK: 13900001,
};

export function isAlreadyExistsError(code) {
  return code === FILE_ERROR.ALREADY_EXISTS || code === FILE_ERROR.ALREADY_EXISTS_NEW_SDK;
}

export const COMICS_URI = "internal://files/comics.json";
export const SETTINGS_URI = "internal://files/settings.json";
export const HISTORY_URI = "internal://files/history.json";
export const SOURCES_URI = "internal://files/sources.json";
export const COOKIE_URI = "internal://files/cookie.json";

// ---- 文件级串行队列：同一 URI 的读-改-写操作排队执行，杜绝并发丢更新 ----
// 纯内存排队，不增加任何 IO；前序失败不阻塞后续操作。
const fileQueues = {};

function enqueueFileOp(uri, op) {
  const prev = fileQueues[uri] || Promise.resolve();
  const run = prev.then(op, op);
  fileQueues[uri] = run;
  // 队列引用清理，避免常驻内存
  run.then(
    () => {
      if (fileQueues[uri] === run) delete fileQueues[uri];
    },
    () => {
      if (fileQueues[uri] === run) delete fileQueues[uri];
    }
  );
  return run;
}

export function readJsonFile(uri, defaultValue, strict) {
  return new Promise((resolve, reject) => {
    file.readText({
      uri: uri,
      success: (data) => {
        try {
          const parsed = data.text ? JSON.parse(data.text) : defaultValue;
          resolve(parsed == null ? defaultValue : parsed);
        } catch (e) {
          if (strict) {
            reject({ parseError: e });
          } else {
            resolve(defaultValue);
          }
        }
      },
      fail: (data, code) => {
        reject({ data: data, code: code });
      },
    });
  });
}

// 原子写：全量内容先写到 .tmp，再 move 到目标文件。
// 数据只写一遍，move 是同目录 rename（元数据操作，不复制数据），
// 崩溃最坏只留下 .tmp 孤儿文件（启动时 cleanTempFiles 自动清理），
// 不会再出现"写一半截断 → 下次读回默认值 → 静默清空索引"。
// move 遇已存在目标是否覆盖未在各固件上逐一验证，失败时退化为 delete+move 兜底。
function writeJsonFileAtomic(uri, value, space) {
  const text = JSON.stringify(value, null, space);
  const tmpUri = uri + ".tmp";
  return new Promise((resolve, reject) => {
    file.writeText({
      uri: tmpUri,
      text: text,
      success: () => {
        const doMove = () => {
          file.move({
            srcUri: tmpUri,
            dstUri: uri,
            success: () => resolve(),
            fail: (data, code) => reject({ data: data, code: code }),
          });
        };
        file.move({
          srcUri: tmpUri,
          dstUri: uri,
          success: () => resolve(),
          fail: () => {
            // 目标已存在且 move 不覆盖的环境：删除后重移一次
            file.delete({
              uri: uri,
              success: doMove,
              fail: doMove,
            });
          },
        });
      },
      fail: (data, code) => {
        reject({ data: data, code: code });
      },
    });
  });
}

export function writeJsonFile(uri, value, space) {
  return enqueueFileOp(uri, () => writeJsonFileAtomic(uri, value, space));
}

// 串行化的"读-改-写"：整个周期在文件队列内完成。
// 文件不存在时用 defaultValue 新建；解析失败等异常时 reject 而不写回，避免清空数据。
// updater 返回新数据（返回 undefined 则沿用读到的数据）。
export function updateJsonFile(uri, defaultValue, updater) {
  return enqueueFileOp(uri, async () => {
    let data;
    try {
      data = await readJsonFile(uri, defaultValue, true);
    } catch (e) {
      if (e && e.code === FILE_ERROR.NOT_FOUND) {
        data = defaultValue;
      } else {
        throw e;
      }
    }
    const updated = updater(data);
    const finalData = updated === undefined ? data : updated;
    await writeJsonFileAtomic(uri, finalData);
    return finalData;
  });
}

export function readComics(strict) {
  return readJsonFile(COMICS_URI, [], strict);
}

export function writeComics(list) {
  return writeJsonFile(COMICS_URI, list);
}

// 更新单个漫画的元数据：updater 接收现有记录（不存在则为 { id }），返回新记录。
// 基于 updateJsonFile：文件不存在时新建列表；串行队列内完成读-改-写，原子落盘。
export function updateComicMeta(id, updater) {
  let updatedRecord;
  return updateJsonFile(COMICS_URI, [], (comics) => {
    const list = Array.isArray(comics) ? comics : [];
    const index = list.findIndex((c) => c.id === id);
    const base = index >= 0 ? list[index] : { id: id };
    const updated = updater(base) || base;
    updatedRecord = updated;
    if (index >= 0) {
      list[index] = updated;
    } else {
      list.push(updated);
    }
    return list;
  }).then(() => updatedRecord);
}

export function readSettings() {
  return readJsonFile(SETTINGS_URI, {});
}

export function writeSettings(settings) {
  return writeJsonFile(SETTINGS_URI, settings);
}

export function readHistory() {
  return readJsonFile(HISTORY_URI, []);
}

export function writeHistory(list) {
  return writeJsonFile(HISTORY_URI, list);
}

export function readSources() {
  return readJsonFile(SOURCES_URI, []);
}

export function writeSources(list) {
  return writeJsonFile(SOURCES_URI, list);
}

export function readCookie() {
  return readJsonFile(COOKIE_URI, {});
}

export function writeCookie(cookie) {
  return writeJsonFile(COOKIE_URI, cookie);
}
