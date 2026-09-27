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
export const SEARCH_HISTORY_URI = "internal://files/search_history.json";

// 持久化文件基名清单（cleanTempFiles 引用）：新增持久化文件必须登记，否则启动
// 清理会把它当临时文件删除（P2-36）
export const PERSISTENT_FILES = [
  COMICS_URI,
  SETTINGS_URI,
  HISTORY_URI,
  SOURCES_URI,
  COOKIE_URI,
  SEARCH_HISTORY_URI,
].map((uri) => uri.split("/").pop());

// ---- 损坏 JSON 自愈（P0-15）----
// 通知回调由页面注入（confirmGuard"页面传入 $t 译文"同款）：storage 层无页面 $t
let recoveryNotifier = null;

export function setRecoveryNotifier(fn) {
  recoveryNotifier = fn;
}

// 提示一次损坏自愈：文件名交给注入的 $t 文案（storage.fileRecovered）
function notifyCorrupt(uri) {
  const name = uri.split("/").pop();
  console.error("JSON 损坏已备份重建: " + name);
  if (recoveryNotifier) {
    recoveryNotifier(name);
  }
}

// 坏文件挪到 uri+".bad" 单代备份（先删旧 .bad 再 move）。
// 必须先备份再重建——否则 updateJsonFile 的原子写会直接覆盖坏文件、现场全毁；
// 备份失败不阻塞读写链（仍按默认继续），.bad 由 cleanTempFiles 白名单保留
function backupCorruptFile(uri) {
  const badUri = uri + ".bad";
  return new Promise((resolve) => {
    const doMove = () => {
      file.move({
        srcUri: uri,
        dstUri: badUri,
        success: () => resolve(),
        fail: () => resolve(),
      });
    };
    file.delete({
      uri: badUri,
      success: doMove,
      fail: doMove,
    });
  });
}

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
          // 解析失败自愈（P0-15）：坏文件先备份为 .bad（单代）保住现场再重建——
          // 否则原子写会覆盖坏文件；备份后按原语义返回：strict reject 交调用方
          // 决定是否重建，非 strict 直接按默认继续（不再静默吞掉损坏事实）
          backupCorruptFile(uri).then(function () {
            notifyCorrupt(uri);
            if (strict) {
              reject({ parseError: e });
            } else {
              resolve(defaultValue);
            }
          });
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
// 文件不存在时用 defaultValue 新建；解析失败时坏文件已由 readJsonFile 备份为 .bad、
// 按默认重建解锁写路径（P0-15，不再永久失败）；其余异常 reject 不写回。
// updater 返回新数据（返回 undefined 则沿用读到的数据）。
export function updateJsonFile(uri, defaultValue, updater) {
  return enqueueFileOp(uri, async () => {
    let data;
    try {
      data = await readJsonFile(uri, defaultValue, true);
    } catch (e) {
      if (e && e.code === FILE_ERROR.NOT_FOUND) {
        data = defaultValue;
      } else if (e && e.parseError) {
        // 坏文件已备份为 .bad（现场不丢）；按默认重建，后续写入生成新文件
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

export function readSources() {
  return readJsonFile(SOURCES_URI, []);
}

export function readCookie() {
  return readJsonFile(COOKIE_URI, {});
}

export function writeCookie(cookie) {
  return writeJsonFile(COOKIE_URI, cookie);
}

// ---- 搜索历史：独立文件（不混阅读历史热路径），最多保留 SEARCH_HISTORY_MAX 条 ----

export function readSearchHistory() {
  return readJsonFile(SEARCH_HISTORY_URI, []);
}

const SEARCH_HISTORY_MAX = 5;

// 记录一次搜索关键词：去重（含过滤历史脏数据）后插到最前，超长截断队尾。
// 走 updateJsonFile 串行队列 + 原子写；返回落盘后的完整列表供页面校对
export function addSearchHistory(keyword) {
  return updateJsonFile(SEARCH_HISTORY_URI, [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    const next = [keyword].concat(arr.filter((k) => typeof k === "string" && k !== keyword));
    return next.slice(0, SEARCH_HISTORY_MAX);
  });
}

export function clearSearchHistory() {
  return writeJsonFile(SEARCH_HISTORY_URI, []);
}
