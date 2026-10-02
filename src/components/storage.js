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

// 统一目录名/章节名特殊字符规范化（P1-31）：防止含 : / ? 等字符导致元数据与磁盘不一致
export function sanitizeFolderName(name) {
  if (!name) return name;
  const invalidChars = /[\\/:*?"<>|]/g;
  return name.replace(invalidChars, "_");
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
  // Only the owner of the current callback may unregister it; an older page's
  // onDestroy must not clear a notifier installed by a newer page instance.
  return function unregisterRecoveryNotifier() {
    if (recoveryNotifier === fn) {
      recoveryNotifier = null;
    }
  };
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

function tryReadValidJson(candidateUri) {
  return new Promise((resolve) => {
    file.readText({
      uri: candidateUri,
      success: (data) => {
        try {
          if (!data || typeof data.text !== "string" || !data.text.trim()) {
            resolve(null);
            return;
          }
          const parsed = JSON.parse(data.text);
          resolve(parsed == null ? null : parsed);
        } catch (err) {
          resolve(null);
        }
      },
      fail: () => resolve(null),
    });
  });
}

function restoreCandidateToTarget(candidateUri, targetUri) {
  return new Promise((resolve) => {
    file.move({
      srcUri: candidateUri,
      dstUri: targetUri,
      success: () => resolve(true),
      fail: () => {
        file.delete({
          uri: targetUri,
          success: () => {
            file.move({
              srcUri: candidateUri,
              dstUri: targetUri,
              success: () => resolve(true),
              fail: () => resolve(false),
            });
          },
          fail: () => resolve(false),
        });
      },
    });
  });
}

function fileExists(uri) {
  return new Promise((resolve) => {
    file.access({
      uri: uri,
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

async function tryRecoverFromBackupOrTmp(uri) {
  const bakUri = uri + ".bak";
  const tmpUri = uri + ".tmp";

  // 1. 优先检查并尝试从 .bak 恢复（最可信的旧有效数据）
  if (await fileExists(bakUri)) {
    const bakData = await tryReadValidJson(bakUri);
    if (bakData !== null) {
      await restoreCandidateToTarget(bakUri, uri);
      file.delete({ uri: tmpUri, success: () => {}, fail: () => {} });
      return bakData;
    }
  }

  // 2. 检查并尝试从 .tmp 恢复（已写完整但未完成 move 的最新数据）
  if (await fileExists(tmpUri)) {
    const tmpData = await tryReadValidJson(tmpUri);
    if (tmpData !== null) {
      await restoreCandidateToTarget(tmpUri, uri);
      file.delete({ uri: bakUri, success: () => {}, fail: () => {} });
      return tmpData;
    }
  }

  return null;
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
          backupCorruptFile(uri).then(async function () {
            // 坏文件已移至 .bad，尝试从 .bak 或 .tmp 救回有效数据
            const recovered = await tryRecoverFromBackupOrTmp(uri);
            if (recovered !== null) {
              console.warn("JSON 损坏已从备份自动自愈: " + uri);
              resolve(recovered);
              return;
            }
            notifyCorrupt(uri);
            if (strict) {
              reject({ parseError: e });
            } else {
              resolve(defaultValue);
            }
          });
        }
      },
      fail: async (data, code) => {
        if (code === FILE_ERROR.NOT_FOUND) {
          // 主文件缺失时，检查是否存在因意外中断留下的 .bak 或 .tmp 备份可供恢复
          const recovered = await tryRecoverFromBackupOrTmp(uri);
          if (recovered !== null) {
            console.warn("缺失的主文件已从备份自动恢复: " + uri);
            resolve(recovered);
            return;
          }
        }
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
  const bakUri = uri + ".bak";

  return new Promise((resolve, reject) => {
    // 写入临时文件
    file.writeText({
      uri: tmpUri,
      text: text,
      success: () => {
        // 尝试直接覆盖重命名（现代平台原子替换）
        file.move({
          srcUri: tmpUri,
          dstUri: uri,
          success: () => {
            // 写入成功后清理历史残留的 .bak
            file.delete({ uri: bakUri, success: () => {}, fail: () => {} });
            resolve();
          },
          fail: (moveErr, moveCode) => {
            // 首次 move 失败：可能是不支持原子覆盖已存在目标，也可能是底层 I/O 故障。
            // 严禁直接无差别 delete 目标（P0-26）：若直接删旧目标，二次 move 若再失败，
            // 正式文件与索引将永久丢失！
            // 安全方案：
            // 1. 先探测目标原文件是否存在。
            file.access({
              uri: uri,
              success: () => {
                // 原文件确实存在，需要将原文件移至 .bak 备份，再将 .tmp 移至正式 uri
                const rollback = (finalErr, finalCode) => {
                  // 二次移动失败，尝试将 .bak 恢复为正式文件，确保旧有效数据不丢
                  file.move({
                    srcUri: bakUri,
                    dstUri: uri,
                    success: () => reject({ data: finalErr, code: finalCode }),
                    fail: () => reject({ data: finalErr, code: finalCode }),
                  });
                };

                const doStep2 = () => {
                  file.move({
                    srcUri: tmpUri,
                    dstUri: uri,
                    success: () => {
                      // 正式文件已成功到位，安全移除备份
                      file.delete({ uri: bakUri, success: () => {}, fail: () => {} });
                      resolve();
                    },
                    fail: (err2, code2) => {
                      rollback(err2, code2);
                    },
                  });
                };

                // 先清理可能存在的过期 .bak，确保重命名到 .bak 成功
                file.delete({
                  uri: bakUri,
                  success: () => {
                    file.move({
                      srcUri: uri,
                      dstUri: bakUri,
                      success: doStep2,
                      fail: (errBak, codeBak) => {
                        // 连备份移动都失败，说明底层发生严重 I/O 错误；
                        // 保留原 uri 不动，清理 .tmp，拒绝操作
                        reject({ data: errBak || moveErr, code: codeBak || moveCode });
                      },
                    });
                  },
                  fail: () => {
                    file.move({
                      srcUri: uri,
                      dstUri: bakUri,
                      success: doStep2,
                      fail: (errBak, codeBak) => {
                        reject({ data: errBak || moveErr, code: codeBak || moveCode });
                      },
                    });
                  },
                });
              },
              fail: () => {
                // 原文件根本不存在，首次 move 失败属于纯粹的 I/O 故障，拒绝操作并保留现场
                reject({ data: moveErr, code: moveCode });
              },
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

// ---- 临时文件清理：清理 internal://files 下的孤立临时文件及无索引关联的孤儿漫画目录（老版本残留补救） ----
export function cleanTempFiles() {
  return new Promise((resolve, reject) => {
    // 递归删除目录辅助函数（优先 rmdir recursive，失败则逐文件递归清空后再 rmdir）
    function removeOrphanDir(dirUri, onDone) {
      file.rmdir({
        uri: dirUri,
        recursive: true,
        success: function () {
          onDone(true);
        },
        fail: function () {
          file.get({
            uri: dirUri,
            recursive: true,
            success: function (data) {
              const allFiles = [];
              function collect(entries) {
                for (let i = 0; i < entries.length; i++) {
                  const entry = entries[i];
                  if (entry.type === "dir" && entry.subFiles) {
                    collect(entry.subFiles);
                  } else if (entry.type !== "dir") {
                    allFiles.push(entry.uri);
                  }
                }
              }
              collect(data.subFiles || []);
              let idx = 0;
              function next() {
                if (idx >= allFiles.length) {
                  file.rmdir({
                    uri: dirUri,
                    recursive: true,
                    success: function () {
                      onDone(true);
                    },
                    fail: function () {
                      onDone(false);
                    },
                  });
                  return;
                }
                file.delete({
                  uri: allFiles[idx++],
                  success: next,
                  fail: next,
                });
              }
              next();
            },
            fail: function () {
              onDone(false);
            },
          });
        },
      });
    }

    readComics()
      .then(function (comicsList) {
        const validIds = new Set(
          (Array.isArray(comicsList) ? comicsList : [])
            .map(function (c) {
              return c && c.id != null ? String(c.id) : "";
            })
            .filter(Boolean)
        );

        file.list({
          uri: "internal://files",
          success: function (data) {
            const files = data.fileList || [];
            const filesToDelete = [];
            const dirsToDelete = [];

            files.forEach(function (item) {
              const name = item.uri.split("/").pop();
              if (item.type === "dir") {
                // 孤儿漫画目录清理（老版本删除残留或未管理目录补救）：
                // 若该目录不是 comics.json 中登记的有效漫画，则作为孤儿残留目录清理
                if (!validIds.has(name)) {
                  dirsToDelete.push(item);
                }
                return;
              }

              if (name.endsWith(".bad")) return;
              if (PERSISTENT_FILES.includes(name)) return;
              if (name.endsWith(".tmp") && PERSISTENT_FILES.includes(name.slice(0, -4))) {
                return;
              }
              if (name.endsWith(".bak") && PERSISTENT_FILES.includes(name.slice(0, -4))) {
                return;
              }
              filesToDelete.push(item);
            });

            const totalItems = filesToDelete.length + dirsToDelete.length;
            if (totalItems === 0) {
              return resolve({ count: 0 });
            }

            let deletedCount = 0;
            let finished = 0;

            function checkDone() {
              finished++;
              if (finished === totalItems) {
                resolve({ count: deletedCount, total: totalItems });
              }
            }

            // 清理孤立临时文件
            filesToDelete.forEach(function (item) {
              file.delete({
                uri: item.uri,
                success: function () {
                  deletedCount++;
                  checkDone();
                },
                fail: function (errData, code) {
                  console.debug("删除临时文件失败: " + item.uri + ", code=" + code);
                  checkDone();
                },
              });
            });

            // 清理孤儿漫画目录
            dirsToDelete.forEach(function (item) {
              removeOrphanDir(item.uri, function (ok) {
                if (ok) deletedCount++;
                checkDone();
              });
            });
          },
          fail: function (errData, code) {
            console.debug("列出临时文件失败, code=" + code);
            reject({ errData: errData, code: code });
          },
        });
      })
      .catch(function () {
        // 读取 comics.json 失败时回退至只清理普通文件，防止误删有效漫画
        console.debug("读取 comics.json 失败，仅清理普通临时文件");
        file.list({
          uri: "internal://files",
          success: function (data) {
            const files = data.fileList || [];
            const filesToDelete = files.filter(function (item) {
              if (item.type === "dir") return false;
              const fileName = item.uri.split("/").pop();
              if (fileName.endsWith(".bad")) return false;
              if (PERSISTENT_FILES.includes(fileName)) return false;
              if (fileName.endsWith(".tmp") && PERSISTENT_FILES.includes(fileName.slice(0, -4))) {
                return false;
              }
              return true;
            });

            if (filesToDelete.length === 0) {
              return resolve({ count: 0 });
            }

            let deletedCount = 0;
            let finished = 0;
            filesToDelete.forEach(function (item) {
              file.delete({
                uri: item.uri,
                success: function () {
                  deletedCount++;
                  finished++;
                  if (finished === filesToDelete.length) {
                    resolve({ count: deletedCount, total: filesToDelete.length });
                  }
                },
                fail: function (errData, code) {
                  console.debug("删除临时文件失败: " + item.uri + ", code=" + code);
                  finished++;
                  if (finished === filesToDelete.length) {
                    resolve({ count: deletedCount, total: filesToDelete.length });
                  }
                },
              });
            });
          },
          fail: function (errData, code) {
            console.debug("列出临时文件失败, code=" + code);
            reject({ errData: errData, code: code });
          },
        });
      });
  });
}
