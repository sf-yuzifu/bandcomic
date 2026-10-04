import prompt from "@system.prompt";
import file from "@system.file";
import {
  readComics,
  readSources,
  writeCookie,
  isAlreadyExistsError,
  updateJsonFile,
  COMICS_URI,
  SOURCES_URI,
  HISTORY_URI,
  comicCoverUri,
  scanComicStorage,
  comicStorageIds,
} from "./storage";
import { CHAPTER_IMPORT_PROTOCOL, legacyComicImportPlan, beginComicImport, commitComicImport, abortComicImport } from "./comicImport";
import { safeJsonParse } from "./jsonUtils";
import { base64Encode, base64ToBytes } from "./base64";
import { replaceIfDuplicate, mergeSourcesToGlobal } from "./api";
import { createStopWaitQueue } from "./stopWaitQueue";
import { createWindowedSender } from "./windowedSender";
import { handleGatewayBind, handleImportHttpTask, handleImportHttpQuery, hasActiveDownload } from "./gatewaySession";
import { isNativeFetchSupported } from "./gatewayFetch";
import { sendHttpData } from "./httpDataSync";
import { deviceDeletes, DELETE_PROTOCOL, deleteComicById, deleteSourceByKey } from "./dataDelete";

// 封面推送读盘切片（手表→手机）：保持 6144 小切片求稳；
// 反方向（插件→设备 fetch 分片）才用 24K，见 interconnfetch.js MAX_CHUNK_SIZE
const COVER_READ_CHUNK_SIZE = 6144;
const ACK_TIMEOUT = 5000;
const COVER_ACK_TIMEOUT = 3000;
const COVER_MAX_RETRY = 2;
const SLICE_MAX_RETRY = 3;
const COVER_PACING_MS = 20;
// 滑窗传输（与插件 transfer.rs 对偶）：方向 A 接收窗口随 hs_pong caps 声明给插件；
// 方向 B 发送窗口以插件 hs_ping caps 为准（clamp [1,16]）
const IMPORT_WINDOW = 4;
// 单文件分片数上限（P1-18①）：防异常 total 撑爆 new Array；远大于任何合法页图所需
const IMPORT_MAX_CHUNKS = 65536;
const SYNC_ACK_TIMEOUT = 3000;
const SYNC_MAX_RETRY = 5;
const SYNC_BUFFER_FRAMES = 8;
const COVER_MAX_CHUNKS = 65536;

function detectImageFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  // RIFF 只是容器（WAV/AVI 同头），必须校验 fourcc 为 "WEBP"（bytes 8-11）
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "image/jpeg";
}

export function createDataBridge(interConnect) {
  const bridge = {};

  let _coverQueue = [];
  let _coverDoneSent = false;
  let _coverFlow = null; // 当前封面停等队列（createStopWaitQueue 实例）
  let _appDataFlow = null;
  let _coverMime = "image/jpeg";
  let _syncSender = null; // 方向 B 滑窗发送器（createWindowedSender 实例，新协议）
  let _pluginCaps = null; // 插件 hs_ping 携带的能力（syncWindow 等），无则走旧停等协议
  let _syncSeq = 0;
  let _syncWireSession = null;
  let _syncHttpRequest = null;
  let _coverReadBusy = false; // 原生读无法取消：迟到回调返回前不叠加新的封面读

  function stopSync() {
    _syncSeq++;
    if (_syncSender) _syncSender.cancel();
    if (_appDataFlow) _appDataFlow.cancel();
    if (_coverFlow) _coverFlow.cancel();
    _syncSender = _appDataFlow = _coverFlow = null;
    bridge.onAppDataAck = null;
    _coverQueue = [];
    _syncWireSession = null;
    _syncHttpRequest = null;
  }

  // 单张封面的发送动作：file.get 拿大小 → 逐切片连发（片间节流 COVER_PACING_MS），
  // 全部发完 ctx.sent() 进入等 cover_ack；任一环失败 ctx.failed() 跳过本张。
  // 切片级失败重试（SLICE_MAX_RETRY）留在本函数内部，与队列的整包重发正交
  function sendCoverItem(c, ctx) {
    const uri = c.storageId ? comicCoverUri(c) : "internal://files/" + c.id + "/cover";
    file.get({
      uri: uri,
      success: function (info) {
        if (ctx.isStale()) return;
        _coverMime = "image/jpeg";
        sendCoverSlice(c, uri, info.length || 0, 0, 0, ctx);
      },
      fail: function () {
        if (ctx.isStale()) return;
        ctx.failed();
      },
    });
  }

  function sendCoverSlice(c, uri, total, pos, sliceRetry, ctx) {
    const len = Math.min(COVER_READ_CHUNK_SIZE, total - pos);
    const isFirst = pos === 0;

    file.readArrayBuffer({
      uri: uri,
      position: pos,
      length: len,
      success: function (bufData) {
        if (ctx.isStale()) return;
        if (!bufData.buffer) {
          ctx.failed();
          return;
        }

        const bytes = new Uint8Array(bufData.buffer);
        if (isFirst) {
          _coverMime = detectImageFormat(bytes);
        }
        const header = isFirst ? "data:" + _coverMime + ";base64," : "";
        const b64 = base64Encode(bufData.buffer);
        const totalChunks = Math.ceil(total / COVER_READ_CHUNK_SIZE);
        const chunkIndex = Math.floor(pos / COVER_READ_CHUNK_SIZE);

        interConnect.send({
          data: {
            type: "cover_data_chunk",
            name: c.name || "",
            index: chunkIndex,
            total: totalChunks,
            data: header + b64,
          },
          success: function () {
            if (ctx.isStale()) return;
            const nextPos = pos + len;
            if (nextPos >= total) {
              // 最后一片发出，进入等 cover_ack（超时由队列整包重发兜底）
              ctx.sent();
            } else {
              setTimeout(function () {
                if (!ctx.isStale()) sendCoverSlice(c, uri, total, nextPos, 0, ctx);
              }, COVER_PACING_MS);
            }
          },
          fail: function () {
            // 发送失败重试当前切片，避免静默丢片导致手机端永远拼不完整
            if (ctx.isStale()) return;
            if (sliceRetry < SLICE_MAX_RETRY) {
              setTimeout(function () {
                if (!ctx.isStale()) sendCoverSlice(c, uri, total, pos, sliceRetry + 1, ctx);
              }, 100);
            } else {
              console.debug("切片重试超限，跳过封面: " + (c.name || ""));
              ctx.failed();
            }
          },
        });
      },
      fail: function () {
        if (ctx.isStale()) return;
        ctx.failed();
      },
    });
  }

  function finishCovers() {
    if (_coverDoneSent) return;
    _coverDoneSent = true;
    _coverQueue = [];
    _coverFlow = null;
    interConnect.send({
      data: { type: "cover_done" },
      success: function () {},
      fail: function () {},
    });
    prompt.showToast({ message: "数据发送完成" });
  }

  function sendCoversOneByOne() {
    if (_coverDoneSent) return;
    const queue = _coverQueue || [];
    if (queue.length === 0) {
      finishCovers();
      return;
    }
    // 每张封面停等：末片发出后等手机端拼完回 cover_ack 才发下一张；
    // ACK 超时整包重发（COVER_MAX_RETRY 次），超限跳过本张
    _coverFlow = createStopWaitQueue({
      label: "封面",
      items: queue,
      keyOf: function (c) {
        return c.name || "";
      },
      ackTimeout: COVER_ACK_TIMEOUT,
      maxRetry: COVER_MAX_RETRY,
      itemPacing: 30,
      sendItem: sendCoverItem,
      onAllDone: finishCovers,
    });
  }

  function sendAppDataBatched(comics, sourceList, seq) {
    // 请求-确认模式：每发一个消息等插件端 ACK 后才发下一个，确保严格顺序
    // 解决安卓端 QAIC 消息乱序问题
    const messages = [];

    messages.push({
      type: "app_data_header",
      comic_count: comics.length,
      source_count: sourceList.length,
    });

    for (let i = 0; i < comics.length; i++) {
      messages.push({ type: "app_data_comic", index: i, comic: comics[i] });
    }

    for (let i = 0; i < sourceList.length; i++) {
      messages.push({ type: "app_data_source", index: i, source: sourceList[i] });
    }

    messages.push({ type: "app_data_done" });

    prompt.showToast({
      message: "正在发送数据 (comic=" + comics.length + " source=" + sourceList.length + ")",
    });

    // 逐消息停等：ACK 超时重发一次仍无响应则跳过（避免死锁）；
    // done 的 ACK 连丢/发送失败也会走到 onAllDone——列表数据大概率已送达，
    // 而手机端在等封面，不能干等挂死（封面流程自带 ACK/重发兜底，有界）
    const flow = createStopWaitQueue({
      label: "消息",
      items: messages,
      keyOf: function (msg, idx) {
        return idx;
      },
      ackTimeout: ACK_TIMEOUT,
      maxRetry: 1,
      sendItem: function (msg, ctx) {
        // 先进入等 ACK 再发：与旧实现"定时器先于 send 启动"语义一致，
        // send 回调缺失时也有超时兜底；send 失败由 ctx.failed() 立即跳过
        ctx.sent();
        interConnect.send({
          data: msg,
          success: function () {},
          fail: function () {
            // 发送失败也继续，避免卡住
            ctx.failed();
          },
        });
      },
      onAllDone: function () {
        if (seq !== _syncSeq) return;
        _appDataFlow = null;
        bridge.onAppDataAck = null;
        // 列表消息全部确认（或兜底跳过）后，安全开始发封面
        setTimeout(function () {
          if (seq === _syncSeq) sendCoversOneByOne();
        }, 100);
      },
    });

    // 挂载 ACK 回调，handleMessage 里收到 app_data_ack 时调用
    _appDataFlow = flow;
    bridge.onAppDataAck = flow.notifyAck;
  }

  function readCoverFile(method, params) {
    if (_coverReadBusy) return Promise.reject(new Error("previous cover read still pending"));
    _coverReadBusy = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        _coverReadBusy = false;
        resolve(value);
      };
      try {
        file[method]({ ...params, success: finish, fail: () => finish(null) });
      } catch (e) {
        finish(null);
      }
    });
  }

  // 一次只生产一帧：列表先出，封面逐片读，单张大封面也不整张驻留。
  function createSyncReader(comics, sourceList, covers, seq) {
    const comicCount = comics.length;
    const sourceCount = sourceList.length;
    let stage = 0;
    let comicIndex = 0;
    let sourceIndex = 0;
    let coverIndex = 0;
    let current = null;
    let stopped = false;
    const stale = () => stopped || seq !== _syncSeq;
    return {
      cancel() {
        stopped = true;
        comics = sourceList = covers = current = null;
      },
      async read() {
        if (stale()) return null;
        if (stage === 0) {
          stage = 1;
          return { type: "app_data_header", comic_count: comicCount, source_count: sourceCount };
        }
        if (stage === 1) {
          if (comicIndex < comicCount) {
            const index = comicIndex++;
            return { type: "app_data_comic", index, comic: comics[index] };
          }
          comics = null;
          stage = 2;
        }
        if (stage === 2) {
          if (sourceIndex < sourceCount) {
            const index = sourceIndex++;
            return { type: "app_data_source", index, source: sourceList[index] };
          }
          sourceList = null;
          stage = 3;
          return { type: "app_data_done" };
        }
        while (stage === 3 && !stale()) {
          if (!current) {
            if (coverIndex >= covers.length) {
              covers = null;
              stage = 4;
              return { type: "cover_done" };
            }
            const cover = covers[coverIndex++];
            if (!cover || !cover.name) continue;
            const uri = cover.storageId ? comicCoverUri(cover) : "internal://files/" + cover.id + "/cover";
            const name = cover.name;
            const info = await readCoverFile("get", { uri });
            if (stale()) return null;
            if (
              !info ||
              !Number.isSafeInteger(info.length) ||
              info.length <= 0 ||
              Math.ceil(info.length / COVER_READ_CHUNK_SIZE) > COVER_MAX_CHUNKS
            )
              continue;
            current = { uri, name, length: info.length, position: 0 };
          }
          const cover = current;
          const len = Math.min(COVER_READ_CHUNK_SIZE, cover.length - cover.position);
          const bufData = await readCoverFile("readArrayBuffer", {
            uri: cover.uri,
            position: cover.position,
            length: len,
          });
          if (stale()) return null;
          if (!bufData || !bufData.buffer || new Uint8Array(bufData.buffer).length !== len) {
            // 删除/短读/读失败：跳过剩余片；插件在cover_done/超时时清理已到的残片。
            current = null;
            continue;
          }
          const index = Math.floor(cover.position / COVER_READ_CHUNK_SIZE);
          const header =
            index === 0
              ? "data:" + detectImageFormat(new Uint8Array(bufData.buffer)) + ";base64,"
              : "";
          const frame = {
            type: "cover_data_chunk",
            name: cover.name,
            index,
            total: Math.ceil(cover.length / COVER_READ_CHUNK_SIZE),
            data: header + base64Encode(bufData.buffer),
          };
          cover.position += len;
          if (cover.position === cover.length) current = null;
          return frame;
        }
        return null;
      },
    };
  }

  function sendAppDataWindowed(comics, sourceList, windowN, seq) {
    prompt.showToast({
      message: "正在发送数据 (comic=" + comics.length + " source=" + sourceList.length + ")",
    });

    const reader = createSyncReader(comics, sourceList, _coverQueue, seq);
    const session = _syncWireSession;
    _syncSender = createWindowedSender({
      label: "同步",
      readFrame: reader.read,
      onStop: reader.cancel,
      maxBufferedFrames: Math.max(SYNC_BUFFER_FRAMES, windowN),
      window: windowN,
      ackTimeout: SYNC_ACK_TIMEOUT,
      maxRetry: SYNC_MAX_RETRY,
      sendFrame: function (f) {
        if (seq !== _syncSeq) return;
        if (session !== null) f.session = session;
        interConnect.send({
          data: f,
          success: function () {},
          fail: function () {
            // 发送失败不立即中止：该帧视为丢失，由 ACK 超时整窗重发兜底
          },
        });
      },
      onAllDone: function () {
        if (seq !== _syncSeq) return;
        _syncSender = null;
        _coverQueue = [];
        prompt.showToast({ message: "数据发送完成" });
      },
      onAbort: function () {
        if (seq !== _syncSeq) return;
        _syncSender = null;
        _coverQueue = [];
        prompt.showToast({ message: "发送中断，请重试" });
      },
    });
  }

  // 按插件握手能力分发：声明了 syncWindow 走滑窗新协议，否则旧停等
  function dispatchAppData(comics, sourceList, seq) {
    if (seq !== _syncSeq) return;
    if (_syncHttpRequest) {
      const request = _syncHttpRequest;
      sendHttpData(request, comics, sourceList, _coverQueue, {
        readFile: readCoverFile,
        isCurrent: () => seq === _syncSeq,
      }).then(async (result) => {
        if (seq !== _syncSeq) return;
        if (result.fallback) {
          prompt.showToast({ message: "HTTP未成功: " + result.error });
          _syncHttpRequest = null;
          await new Promise((resolve, reject) => interConnect.send({
            data: { type: "data_sync_transport", session: request.session, transport: "interconnect", reason: result.error },
            success: resolve, fail: reject,
          }));
          if (seq === _syncSeq) dispatchAppData(comics, sourceList, seq);
        } else {
          _coverQueue = [];
          prompt.showToast({ message: "数据发送完成" });
        }
      }).catch((error) => {
        if (seq !== _syncSeq) return;
        _coverQueue = [];
        prompt.showToast({ message: "HTTP异常: " + (error.message || error) });
        interConnect.send({ data: { type: "data_sync_result", session: request.session,
          success: false, error: String(error.message || error) }, fail() {} });
        prompt.showToast({ message: "发送中断，请重试" });
      });
      return;
    }
    const win =
      _pluginCaps && typeof _pluginCaps.syncWindow === "number" ? _pluginCaps.syncWindow : 0;
    if (win > 0) {
      sendAppDataWindowed(comics, sourceList, Math.min(Math.max(Math.floor(win), 1), 16), seq);
      return;
    }
    sendAppDataBatched(comics, sourceList, seq);
  }

  function readSourcesAndSend(comics, seq) {
    readSources().then(
      function (rawSources) {
        if (seq !== _syncSeq) return;
        let sourceList = [];
        if (Array.isArray(rawSources)) {
          sourceList = rawSources.map(function (s) {
            const key = Object.keys(s)[0];
            const info = s[key];
            return {
              key: key,
              name: (info && info.name) || key,
              apiUrl: (info && info.apiUrl) || "",
            };
          });
        }

        dispatchAppData(comics, sourceList, seq);
      },
      function () {
        dispatchAppData(comics, [], seq);
      }
    );
  }

  function sendAppData(session, http) {
    stopSync();
    const seq = _syncSeq;
    _syncWireSession =
      _pluginCaps && _pluginCaps.syncSession === true && typeof session === "string"
        ? session
        : null;
    if (_pluginCaps && _pluginCaps.httpDataSync === 1 && isNativeFetchSupported() && http) {
      _syncHttpRequest = { session, http };
    }
    _coverDoneSent = false;
    readComics().then(
      function (comicsList) {
        if (seq !== _syncSeq) return;
        if (!Array.isArray(comicsList)) {
          comicsList = [];
        }

        _coverQueue = comicsList;

        if (comicsList.length === 0) {
          readSourcesAndSend([], seq);
          return;
        }

        const comics = [];
        let pending = comicsList.length;

        comicsList.forEach(function (c) {
          const pushMeta = function (pageCount, chapterCount) {
            if (seq !== _syncSeq) return;
            comics.push({
              id: c.id || "",
              name: c.name || "",
              page_count: pageCount,
              chapters: chapterCount,
              bookId: c.bookId || "",
            });

            pending--;
            if (pending === 0) {
              readSourcesAndSend(comics, seq);
            }
          };

          // 元数据可信（有 chapters 且无疑似下载中断的滞后）时直接算，避免每本递归扫盘。
          // 口径与导入侧一致：页数 = 各章已下载页数之和（修复连载只数顶层文件恒为 0 的旧口径），
          // 章数 = 登记章节数；中断滞后/无元数据的旧漫画才扫盘兜底（同一口径）
          const chaptersMeta = Array.isArray(c.chapters) ? c.chapters : [];
          const metaTrusted =
            chaptersMeta.length > 0 &&
            !chaptersMeta.some(function (ch) {
              return (ch.downloaded || 0) < (ch.page_count || 0);
            });

          if (metaTrusted) {
            let pageCount = 0;
            let chapterCount = 0;
            chaptersMeta.forEach(function (ch) {
              pageCount += ch.downloaded || 0;
              if (c.is_serial && ch.num > 0) {
                chapterCount++;
              }
            });
            pushMeta(pageCount, chapterCount);
            return;
          }

          if (c.storageId) {
            scanComicStorage(c).then((stats) => pushMeta(stats.chapters.reduce((n, ch) => n + ch.downloaded, 0),
              c.is_serial ? stats.chapters.length : 0), () => pushMeta(0, c.is_serial ? chaptersMeta.length : 0));
            return;
          }

          file.get({
            uri: "internal://files/" + c.id,
            recursive: true,
            success: function (fileData) {
              if (seq !== _syncSeq) return;
              let pageCount = 0;
              let chapterCount = 0;

              if (fileData.subFiles) {
                fileData.subFiles.forEach(function (f) {
                  if (f.type === "dir") {
                    chapterCount++;
                    pageCount += (f.subFiles || []).length;
                  } else if (f.uri.split("/").pop() !== "cover") {
                    pageCount++;
                  }
                });
              }

              pushMeta(pageCount, chapterCount);
            },
            fail: function () {
              pushMeta(0, 0);
            },
          });
        });
      },
      function () {
        readSourcesAndSend([], seq);
      }
    );
  }

  // 只认同步器插件的明确 Cookie 格式：{"type":"cookie", "<源名>": "<cookie字符串>"}
  // 其余字段/消息一律丢弃并记日志，防止噪声数据覆盖或污染书源 Cookie
  function handleCookieMessage(parsedObj) {
    const cookieData = {};
    let hasValidField = false;

    Object.keys(parsedObj).forEach(function (key) {
      if (key === "type") return;
      const value = parsedObj[key];
      if (key && typeof value === "string") {
        cookieData[key] = value;
        hasValidField = true;
      } else {
        console.debug("丢弃非法Cookie字段: " + key);
      }
    });

    if (!hasValidField) {
      console.debug("丢弃空Cookie消息：无有效的 源名->Cookie 字段");
      return;
    }

    prompt.showToast({ message: "收到Cookie数据" });
    if (!global.cookie) {
      global.cookie = {};
    }
    Object.assign(global.cookie, cookieData);

    writeCookie(global.cookie).then(
      () => {
        prompt.showToast({ message: "Cookie保存成功！" });
      },
      () => {
        prompt.showToast({ message: "Cookie保存失败" });
      }
    );
  }

  function handleSourceConfig(configs) {
    prompt.showToast({ message: "正在保存漫画源配置..." });

    updateJsonFile(SOURCES_URI, [], function (existingConfigs) {
      let list = Array.isArray(existingConfigs) ? existingConfigs : [];
      configs.forEach(function (newConfig) {
        list = replaceIfDuplicate(list, newConfig);
      });
      return list;
    }).then(
      function () {
        mergeSourcesToGlobal(configs);
        bridge.onSourceConfigSaved();
        prompt.showToast({ message: "漫画源配置已保存！" });
      },
      function (e) {
        prompt.showToast({ message: "保存漫画源配置失败: " + (e && e.code) });
      }
    );
  }

  let _importState = null;
  let _importSessionSeq = 0;
  let _lastImportResult = null;

  // 清理导入会话占用的临时目录与残存文件（重入打断、握手取消或失效废弃时调用）
  function cleanupImportDir(targetDirUri) {
    if (!targetDirUri) return;
    try {
      file.access({
        uri: targetDirUri,
        success: function () {
          file.rmdir({
            uri: targetDirUri,
            recursive: true,
            success: function () {},
            fail: function () {},
          });
        },
        fail: function () {},
      });
    } catch (e) {
      // 捕获异常避免阻断后续流程
    }
  }

  // 取消或废弃当前的导入状态
  function cancelCurrentImport(reason) {
    _importSessionSeq++;
    if (!_importState) return;
    const oldState = _importState;
    oldState.cancelled = true;
    _importState = null;
    _lastImportResult = null;
    if (reason) {
      console.debug("取消导入会话 [" + oldState.sessionId + "]: " + reason);
    }
    // 清理未完成半成品目录
    if (oldState.transaction) abortComicImport(oldState.transaction);
    else cleanupImportDir(oldState.dirUri);
  }

  // 启动一个文件的异步落盘：回调只认捕获的 state（不碰全局 _importState），
  // 会话已取消则丢弃落盘结果，不推进后续索引
  function startImportWrite(state, uri, data, fileKey) {
    state.inflightWrites++;
    const release = state.transaction ? state.transaction.lease.retain() : () => {};
    writeBinaryFromBase64(
      uri,
      data,
      function () {
        state.inflightWrites--;
        release();
        if (state.cancelled) return;
        state.completedFiles++;
        if (fileKey) {
          state.savedFiles[fileKey] = true;
        }
        if (state.completedFiles % 5 === 0 || state.completedFiles === state.totalFiles) {
          prompt.showToast({
            message: "接收 " + state.completedFiles + "/" + state.totalFiles,
            duration: 500,
          });
        }
        maybeFinalizeImport(state);
      },
      function () {
        state.inflightWrites--;
        release();
        if (state.cancelled) return;
        state.completedFiles++;
        state.failedFiles++;
        if (fileKey) {
          state.failedFilesList[fileKey] = true;
        }
        maybeFinalizeImport(state);
      }
    );
  }

  // 多章模式可选书级封面的落盘：不计入 totalFiles 文件计数，但受 inflightWrites 保护与落盘记录
  function startImportCoverWrite(state, uri, data) {
    state.inflightWrites++;
    const release = state.transaction ? state.transaction.lease.retain() : () => {};
    writeBinaryFromBase64(
      uri,
      data,
      function () {
        state.inflightWrites--;
        release();
        if (state.cancelled) return;
        state.savedFiles["cover"] = true;
        maybeFinalizeImport(state);
      },
      function () {
        state.inflightWrites--;
        release();
        if (state.cancelled) return;
        state.failedFilesList["cover"] = true;
        maybeFinalizeImport(state);
      }
    );
  }

  // done 已收到且所有写入（在途 + 待写）都完成后才真正收尾
  function maybeFinalizeImport(state) {
    if (!state || state.cancelled || !state.doneReceived) return;
    if (!state.dirReady) return;
    if (state.pendingWrites.length > 0) return;
    if (state.inflightWrites > 0) return;
    finalizeImport(state);
  }

  function reportImportResult(state, overallSuccess, downloadedPages, totalFailed, indexSuccess, error) {
    if (!state || state.cancelled) return;
    const success = overallSuccess && totalFailed === 0 && indexSuccess;
    let errMsg = error;
    if (!errMsg && totalFailed > 0) {
      errMsg = totalFailed + " 个文件保存失败";
    }
    const result = {
      type: "import_comic_result",
      sessionId: state.sessionId,
      comicId: state.comicId,
      name: state.comicName,
      success: success,
      savedPages: downloadedPages,
      totalPages: state.pageCount,
      failedFiles: totalFailed,
      indexSuccess: indexSuccess,
      error: errMsg || null,
    };
    _lastImportResult = result;
    try {
      interConnect.send({
        data: result,
        success: function () {},
        fail: function (err) {
          console.debug("发送 import_comic_result 失败: " + JSON.stringify(err));
        },
      });
    } catch (e) {
      console.debug("发送 import_comic_result 异常: " + e);
    }
  }

  function finalizeImport(state) {
    if (state.cancelled || state.finalizing) return;
    state.finalizing = true;

    // 核对实际落盘成功的正式文件数量（区分已声明文件、成功落盘、缺失残片与写盘失败）
    let totalSaved = 0;
    if (state.mode === "single") {
      state.files.forEach(function (f) {
        if (state.savedFiles[f]) totalSaved++;
      });
    } else if (state.chapters) {
      state.chapters.forEach(function (ch, ci) {
        const chapName = (ch.name || "").trim() || "第" + (ci + 1) + "章";
        (ch.files || []).forEach(function (f) {
          if (state.savedFiles[chapName + "/" + f]) totalSaved++;
        });
      });
    }
    const totalFailed = Math.max(0, state.totalFiles - totalSaved);

    let downloadedPages = 0;
    if (state.mode === "single") {
      const hasCover = state.files.indexOf("cover") !== -1;
      downloadedPages = state.files.filter(function (f) {
        return (hasCover ? f !== "cover" : true) && !!state.savedFiles[f];
      }).length;
    } else if (state.chapters) {
      state.chapters.forEach(function (ch, ci) {
        const chapName = (ch.name || "").trim() || "第" + (ci + 1) + "章";
        (ch.files || []).forEach(function (f) {
          if (state.savedFiles[chapName + "/" + f]) downloadedPages++;
        });
      });
    }

    const indexPromise = state.transaction ? (totalFailed || Object.keys(state.failedFilesList).length ?
      Promise.reject(new Error("文件未完整保存，旧章节已保留")) :
      commitComicImport(state.transaction, !!state.savedFiles.cover)) : updateComicsIndex(
      state.comicId,
      state.comicName,
      state.pageCount,
      state.isSerial,
      state.chapters,
      state.savedFiles,
      state.files,
      totalFailed === 0 && Object.keys(state.failedFilesList).length === 0
    );

    let msg =
      "导入完成: " +
      state.comicName +
      " (" +
      totalSaved +
      "/" +
      state.totalFiles +
      "文件";
    if (totalFailed > 0) {
      msg += "，" + totalFailed + "个失败";
    }
    msg += ")";
    prompt.showToast({
      message: msg,
    });

    // 释放残片缓冲与滑窗乱序缓存
    state.buffers = {};
    state.gbuf = null;
    state.pendingWrites = [];

    if (_importState === state) {
      _importState = null;
    }

    if (indexPromise && typeof indexPromise.then === "function") {
      indexPromise.then(
        function () {
          if (state.transaction) state.comicId = state.transaction.targetId;
          reportImportResult(state, true, downloadedPages, totalFailed, true, null);
        },
        function (e) {
          if (state.transaction) abortComicImport(state.transaction);
          const errMsg = e && (e.message || e.code) ? "索引更新失败: " + (e.message || e.code) : "索引更新失败";
          reportImportResult(state, false, downloadedPages, totalFailed, false, errMsg);
        }
      );
    } else {
      reportImportResult(state, totalFailed === 0, downloadedPages, totalFailed, true, null);
    }

    // 整本导入收尾，导入缓冲已释放，主动收一次 GC
    if (typeof global !== "undefined" && global.runGC) global.runGC();
  }

  function handleImportComic(parsed) {
    const msgType = parsed.type || "";
    if (msgType === "import_comic_header") {
      handleImportComicHeader(parsed);
    } else if (msgType === "import_comic_chunk") {
      handleImportComicChunk(parsed);
    } else if (msgType === "import_comic_done") {
      handleImportComicDone(parsed);
    } else {
      prompt.showToast({ message: "未知导入消息类型: " + msgType });
    }
  }

  function handleImportComicHeader(parsed, transaction) {
    if (typeof hasActiveDownload === "function" && hasActiveDownload()) {
      interConnect.send({
        data: {
          type: "import_comic_result",
          sessionId: parsed.sessionId || parsed.session,
          name: parsed.name,
          success: false,
          savedPages: 0,
          totalPages: 0,
          failedFiles: 0,
          indexSuccess: false,
          error: "设备正在进行 HTTP 下载，互联导入已拒绝",
        },
        fail() {},
      });
      prompt.showToast({ message: "HTTP 下载进行中，已拒绝互联导入" });
      return;
    }
    if (typeof global !== "undefined") {
      if (global.APP_SETTING && global.APP_SETTING.oobeDone === false) {
        interConnect.send({
          data: {
            type: "import_comic_result",
            sessionId: parsed.sessionId || parsed.session,
            name: parsed.name,
            success: false,
            savedPages: 0,
            totalPages: 0,
            failedFiles: 0,
            indexSuccess: false,
            error: "设备处于首次设置引导中，互联导入已拒绝",
          },
          fail() {},
        });
        prompt.showToast({ message: "首次设置引导中，已拒绝导入" });
        return;
      }
      if (global.updatePageShowing || (global.pendingUpdateInfo && global.pendingUpdateInfo.forceUpdate)) {
        interConnect.send({
          data: {
            type: "import_comic_result",
            sessionId: parsed.sessionId || parsed.session,
            name: parsed.name,
            success: false,
            savedPages: 0,
            totalPages: 0,
            failedFiles: 0,
            indexSuccess: false,
            error: "设备处于更新引导中，互联导入已拒绝",
          },
          fail() {},
        });
        prompt.showToast({ message: "应用更新中，已拒绝导入" });
        return;
      }
    }
    if (_importState && !transaction && (parsed.sessionId || parsed.session) === _importState.sessionId && !_importState.cancelled) {
      interConnect.send({ data: { type: "import_header_ack", name: _importState.comicName,
        sessionId: _importState.sessionId, session: _importState.sessionId }, fail() {} });
      return;
    }
    if (parsed.importChapterProtocol != null && !transaction) {
      cancelCurrentImport("准备新的章节导入");
      const preparation = _importSessionSeq;
      Promise.resolve().then(() => beginComicImport(legacyComicImportPlan(parsed))).then((tx) => {
        if (preparation !== _importSessionSeq) { abortComicImport(tx); return; }
        handleImportComicHeader(parsed, tx);
      }, (error) => {
        interConnect.send({ data: { type: "import_comic_result", sessionId: parsed.sessionId,
          name: parsed.name, success: false, savedPages: 0, totalPages: 0, failedFiles: 0,
          indexSuccess: false, error: error.message || String(error) }, fail() {} });
      });
      return;
    }
    const comicName = parsed.name || "";
    const mode = parsed.mode || "single";
    const files = parsed.files || [];
    const chapters = parsed.chapters || null;

    if (!comicName) {
      prompt.showToast({ message: "导入失败：未提供漫画名称" });
      return;
    }

    const comicId = transaction ? transaction.stageId : "local_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const dirUri = "internal://files/" + comicId;
    const sessionId = parsed.sessionId || parsed.session || comicId;
    const sessionGeneration = ++_importSessionSeq;

    // 若已有正在进行的导入会话，取消旧会话并清理半成品，确保新导入互斥
    cancelCurrentImport("收到新的导入头部 (" + comicName + ")");
    _lastImportResult = null;

    let pageCount = 0;
    const isSerial = mode === "multi";

    if (mode === "single") {
      // files: ["cover", "1", "2", ...], 减去封面就是页数
      pageCount = files.filter((f) => f !== "cover").length;
    } else if (chapters) {
      // 所有章节的文件总数（多章模式书级封面独立于 chapters 发送，不参与页数统计）
      let totalFileCount = 0;
      chapters.forEach(function (ch) {
        totalFileCount += (ch.files || []).length;
      });
      pageCount = totalFileCount;
    }

    const state = {
      comicId: comicId,
      transaction,
      dirUri: dirUri,
      comicName: comicName,
      sessionId: sessionId,
      sessionGeneration: sessionGeneration,
      cancelled: false,
      mode: mode,
      files: [],
      chapters: chapters,
      buffers: {},
      savedFiles: {},
      writingFiles: {},
      failedFilesList: {},
      totalFiles: 0,
      completedFiles: 0,
      pageCount: pageCount,
      isSerial: isSerial,
      dirReady: false,
      pendingDirs: 1, // 尚未就绪的目录数（根目录；章节目录在根目录就绪后挂入）
      pendingWrites: [],
      failedFiles: 0,
      inflightWrites: 0, // 在途异步写入数：done 收尾前必须归零
      doneReceived: false,
      // 滑窗会话（头部带 wchunks）：gseq 乱序缓存 + 连续前沿；旧插件无 wchunks 保持 null
      gbuf: null,
      gnext: 0,
      gtotal: 0,
    };
    _importState = state;
    if (typeof parsed.wchunks === "number") {
      state.gbuf = {};
      state.gtotal = parsed.wchunks;
    }

    if (mode === "single") {
      files.forEach(function (f) {
        state.files.push(f);
        state.totalFiles++;
      });
    } else if (chapters) {
      chapters.forEach(function (ch, ci) {
        // 与插件端归一化规则镜像（trim 后为空则回退 "第N章"），两端独立计算保证一致
        const chapName = (ch.name || "").trim() || "第" + (ci + 1) + "章";
        const chapFiles = ch.files || [];
        chapFiles.forEach(function (f) {
          const fileKey = chapName + "/" + f;
          state.files.push(fileKey);
          state.totalFiles++;
        });
      });
      // 多章模式书级封面：插件独立于 chapters 发送（用户可选，可能没有），
      // 加入验收清单避免分片被当未知拒收，但不计入文件数（见 handleImportComicChunk）
      state.files.push("cover");
    }

    prompt.showToast({
      message: "开始接收: " + comicName + " (" + state.totalFiles + "文件)",
    });

    function flushPendingWrites() {
      if (state.cancelled || !state.pendingWrites) return;
      const pending = state.pendingWrites;
      state.pendingWrites = [];
      pending.forEach(function (w) {
        if (state.cancelled) return;
        if (w.isCover) {
          startImportCoverWrite(state, w.uri, w.data);
          return;
        }
        startImportWrite(state, w.uri, w.data, w.fileKey);
      });
    }

    // 目录就绪计数归零：dirReady 置位，冲刷待写队列，并尝试收尾
    function onOneDirReady() {
      if (state.cancelled) return;
      state.pendingDirs--;
      if (state.pendingDirs > 0) return;
      state.dirReady = true;
      flushPendingWrites();
      maybeFinalizeImport(state);
    }

    // 根目录就绪后再建章节目录（recursive:false 要求父目录存在，否则章节 mkdir 会失败丢文件）
    function onRootDirReady() {
      if (state.cancelled) return;
      if (state.mode === "multi" && state.chapters && state.chapters.length > 0) {
        state.pendingDirs = state.chapters.length;
        state.chapters.forEach(function (ch, ci) {
          // 与分片键构造同源归一化，保证 mkdir 落点与写入路径一致
          const chapName = (ch.name || "").trim() || "第" + (ci + 1) + "章";
          importFile(state, "mkdir", {
            uri: state.dirUri + "/" + chapName,
            recursive: false,
            success: function () {
              onOneDirReady();
            },
            fail: function (data, code) {
              if (!isAlreadyExistsError(code)) {
                console.debug("创建章节目录失败 code=" + code);
              }
              onOneDirReady();
            },
          });
        });
      } else {
        state.pendingDirs = 0;
        state.dirReady = true;
        flushPendingWrites();
        maybeFinalizeImport(state);
      }
    }

    importFile(state, "mkdir", {
      uri: dirUri,
      recursive: false,
      success: function () {
        onRootDirReady();
      },
      fail: function (data, code) {
        if (!isAlreadyExistsError(code)) {
          console.debug("创建根目录失败: " + code);
        }
        onRootDirReady();
      },
    });

    // 头部就绪确认：插件收到后才开始发分片。
    // 部分平台（如安卓）消息可能乱序，分片先于头部到达会被丢弃
    const ackData = { type: "import_header_ack", name: comicName };
    if (parsed.sessionId || parsed.session) {
      ackData.sessionId = sessionId;
      ackData.session = sessionId;
    }
    interConnect.send({
      data: ackData,
      success: function () {},
      fail: function (data, code) {
        console.debug("import_header_ack 发送失败:", code);
      },
    });
  }

  // 单片落位：校验清单 → 写入 per-file 缓冲 → 齐则合并落盘。
  // 纯数据逻辑不含 ACK 回复，逐片旧协议与滑窗新协议共用
  function consumeImportChunk(fileKey, index, total, data) {
    const state = _importState;
    if (state.writingFiles[fileKey] || state.savedFiles[fileKey]) return;
    // 严格匹配：fileKey 必须在头部声明的文件清单内，否则视为异常分片
    if (state.files.indexOf(fileKey) === -1) {
      console.debug("未知分片文件: " + fileKey);
      return;
    }

    // index/total 越界防御（P1-18①）：异常 total 会撑大 new Array，越界/重复的
    // index 会灌水 received 提前凑满、join("") 把空洞拼进 base64 静默写坏文件
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(total) ||
      total <= 0 ||
      total > IMPORT_MAX_CHUNKS ||
      index < 0 ||
      index >= total
    ) {
      console.debug("异常分片参数: index=" + index + ", total=" + total);
      return;
    }

    if (!state.buffers[fileKey]) {
      state.buffers[fileKey] = {
        chunks: new Array(total),
        received: 0,
        total: total,
      };
    }

    const buf = state.buffers[fileKey];
    // total 须与首片一致，防止中途换参数把计数搅浑
    if (buf.total !== total) {
      console.debug("分片 total 不一致: " + total + " != " + buf.total);
      return;
    }
    // 判重用 !== undefined（P1-18①）：空字符串分片 truthy 判不了重复，
    // 重复到达会重复 received++（interconnfetch.js 同款正确写法）
    if (buf.chunks[index] !== undefined) {
      // 重复分片：数据忽略（ACK 由调用方按协议形态回复）
      return;
    }

    buf.chunks[index] = data;
    buf.received++;

    if (buf.received === buf.total) {
      state.writingFiles[fileKey] = true;
      const fullBase64 = buf.chunks.join("");
      const fileUri = state.dirUri + "/" + fileKey;
      delete state.buffers[fileKey];

      // 多章模式书级封面不参与文件计数（插件端可选发送，缺失不报错）；
      // 单本模式的 cover 在 header files 清单内，走正常计数路径
      const isUncountedCover = state.mode === "multi" && fileKey === "cover";
      if (isUncountedCover) {
        if (state.dirReady) {
          startImportCoverWrite(state, fileUri, fullBase64);
        } else {
          state.pendingWrites.push({ uri: fileUri, data: fullBase64, isCover: true, fileKey: fileKey });
        }
        return;
      }

      if (state.dirReady) {
        startImportWrite(state, fileUri, fullBase64, fileKey);
      } else {
        state.pendingWrites.push({
          uri: fileUri,
          data: fullBase64,
          fileKey: fileKey,
        });
      }
    }
  }

  // 滑窗会话的累计 ACK：ack = 下一个仍缺失的连续 gseq
  function sendImportCumAck(comicName, ack, sessionId) {
    const data = { type: "import_chunk_ack", name: comicName, ack: ack };
    if (sessionId) {
      data.sessionId = sessionId;
      data.session = sessionId;
    }
    interConnect.send({
      data: data,
      success: function () {},
      fail: function () {},
    });
  }

  // 滑窗分片：乱序落位 gbuf，从连续前沿按序消费；每收一片回一次累计 ACK
  // （增量 ACK 是发送方窗口不死锁的硬性前提）；重复片只回 ACK 不落数据
  function handleImportChunkWindowed(parsed, comicName) {
    const state = _importState;
    if (!state || state.cancelled) return;
    const gseq = parsed.gseq;
    if (gseq < state.gnext || state.gbuf[gseq] !== undefined) {
      sendImportCumAck(comicName, state.gnext, state.sessionId);
      return;
    }
    state.gbuf[gseq] = parsed;
    while (state.gbuf[state.gnext] !== undefined) {
      const frame = state.gbuf[state.gnext];
      delete state.gbuf[state.gnext];
      state.gnext++;
      // 未知 fileKey 也照常推进前沿（只不落盘），否则发送方窗口停滞
      consumeImportChunk(frame.file || "", frame.index, frame.total, frame.data || "");
    }
    sendImportCumAck(comicName, state.gnext, state.sessionId);
  }

  function handleImportComicChunk(parsed) {
    if (!_importState || _importState.cancelled) {
      console.debug("收到分片但没有有效的 importState");
      return;
    }

    const state = _importState;
    const comicName = parsed.name || "";
    const incomingSession = parsed.sessionId || parsed.session || "";

    // 会话隔离检查：若分片带有 session 字段，严格比对；若未带 session，则核对漫画名
    if (incomingSession && incomingSession !== state.sessionId) {
      console.debug(
        "分片 session 不匹配，丢弃: " + incomingSession + " vs " + state.sessionId
      );
      return;
    }
    if (comicName && comicName !== state.comicName) {
      console.debug("分片漫画名不匹配，丢弃: " + comicName + " vs " + state.comicName);
      return;
    }

    // 滑窗会话（头部带 wchunks 且帧带 gseq）
    if (state.gbuf && typeof parsed.gseq === "number") {
      handleImportChunkWindowed(parsed, comicName);
      return;
    }

    // 旧版逐片停等路径：每片回逐片 ACK（未知文件/重复片也回，防插件超时重传死循环）
    const fileKey = parsed.file || "";
    consumeImportChunk(fileKey, parsed.index, parsed.total, parsed.data || "");
    const chunkAck = {
      type: "import_chunk_ack",
      name: comicName,
      file: fileKey,
      index: parsed.index,
    };
    if (state.sessionId) {
      chunkAck.sessionId = state.sessionId;
      chunkAck.session = state.sessionId;
    }
    interConnect.send({
      data: chunkAck,
    });
  }

  function handleImportComicDone(parsed) {
    if (!_importState || _importState.cancelled) return;

    const state = _importState;
    const comicName = parsed.name || "";
    const incomingSession = parsed.sessionId || parsed.session || "";

    // 会话隔离检查：若 done 消息带有 session，严格比对；未带 session 则严格比对漫画名
    if (incomingSession && incomingSession !== state.sessionId) {
      console.debug(
        "完成消息 session 不匹配，丢弃: " + incomingSession + " vs " + state.sessionId
      );
      return;
    }
    if (comicName && comicName !== state.comicName) {
      console.debug("完成消息漫画名不匹配，丢弃: " + comicName + " vs " + state.comicName);
      return;
    }

    // 只标记 done 到达：base64 落盘是异步的，可能还有在途/待写文件，
    // 等 maybeFinalizeImport 确认全部写完才收尾，否则回调访问 state 会 TypeError、
    // 失败统计也会漏记在途写入
    state.doneReceived = true;
    maybeFinalizeImport(state);
  }

  function writeBinaryFromBase64(fileUri, base64Data, onSuccess, onFail) {
    try {
      const bytes = base64ToBytes(base64Data);
      if (bytes.length === 0) {
        console.debug(fileUri + " 解码后为空");
        prompt.showToast({ message: "解码失败: 数据为空", duration: 1500 });
        onFail && onFail();
        return;
      }
      // 快应用 writeArrayBuffer 的 buffer 参数类型可能是 Uint8Array 或 ArrayBuffer
      // 先尝试传 Uint8Array（兼容华为/小米部分快应用实现）
      file.writeArrayBuffer({
        uri: fileUri,
        buffer: bytes,
        success: onSuccess,
        fail: function (data, code) {
          // 如果 Uint8Array 不行，回退到 ArrayBuffer
          file.writeArrayBuffer({
            uri: fileUri,
            buffer: bytes.buffer,
            success: onSuccess,
            fail: function (data2, code2) {
              console.debug(
                fileUri + " 二进制写入失败 code=" + code2 + " (回退也失败 code=" + code + ")"
              );
              prompt.showToast({
                message: "文件写入失败 code=" + code2,
                duration: 2000,
              });
              onFail && onFail();
            },
          });
        },
      });
    } catch (e) {
      console.debug("base64解码/写入失败: " + e + " uri=" + fileUri);
      prompt.showToast({ message: "解码异常: " + e, duration: 2000 });
      onFail && onFail();
    }
  }

  function updateComicsIndex(
    comicId,
    comicName,
    pageCount,
    isSerial,
    chapters,
    savedFiles,
    files,
    allowReplace = true
  ) {
    // 章节元数据：导入按真实成功落盘的文件数登记 downloaded；size 缺失，离线页首次进入会扫描回写真实值
    let chaptersMeta;
    if (isSerial && Array.isArray(chapters)) {
      chaptersMeta = chapters.map(function (ch, i) {
        const count = (ch.files || []).length;
        const chapName = (ch.name || "").trim() || "第" + (i + 1) + "章";
        const downloaded = savedFiles
          ? (ch.files || []).filter(function (f) {
              return !!savedFiles[chapName + "/" + f];
            }).length
          : count;
        // 插件按 "<章号><全角空格><章名>" 命名章节目录与分片键；
        // 元数据沿用下载链路约定：num 单列、name 不带前缀（阅读页再拼回带前缀的目录名）
        const rawName = ch.name || "";
        const parts = rawName.split("　");
        const hasPrefix = parts.length > 1 && /^\d+$/.test(parts[0]);
        return {
          num: hasPrefix ? parseInt(parts[0], 10) : i + 1,
          name: hasPrefix ? parts.slice(1).join("　") : rawName,
          page_count: count,
          downloaded: downloaded,
        };
      });
    } else {
      let downloaded = pageCount || 0;
      if (savedFiles && Array.isArray(files)) {
        const hasCover = files.indexOf("cover") !== -1;
        downloaded = files.filter(function (f) {
          return (hasCover ? f !== "cover" : true) && !!savedFiles[f];
        }).length;
      }
      chaptersMeta = [{ num: 0, name: "", page_count: pageCount || 0, downloaded: downloaded }];
    }

    const entry = {
      id: comicId,
      name: comicName,
      page_count: pageCount || 0,
      is_serial: !!isSerial,
      chapters: chaptersMeta,
      downloaded_at: Date.now(),
    };

    let replacedOldId = null;
    let replacedRoots = [];

    // 串行队列内读-改-写 + 原子落盘，避免与下载/阅读路径并发时丢条目
    return updateJsonFile(COMICS_URI, [], function (comicsList) {
      const list = Array.isArray(comicsList) ? comicsList : [];
      // 区分来源（P1-30）：仅替换属于导入来源（以 local_ 开头）的同名条目，绝不误篡改在线下载记录
      const candidates = list.filter(function (c) {
        return (
          c &&
          c.name === comicName &&
          typeof c.id === "string" &&
          c.id.startsWith("local_")
        );
      });
      const existing = allowReplace && candidates.length === 1 ? candidates[0] : null;

      if (existing) {
        replacedRoots = existing.storageId ? comicStorageIds(existing) : [existing.id];
        if (existing.id !== comicId) {
          replacedOldId = existing.id;
        }
        existing.id = comicId;
        existing.page_count = entry.page_count;
        existing.is_serial = entry.is_serial;
        existing.chapters = entry.chapters;
        existing.downloaded_at = entry.downloaded_at;
        // Old plugins do not send a version reference. Their fresh legacy root
        // must not inherit the replaced book's imported physical locations.
        delete existing.storageId;
        delete existing.bookId;
        delete existing.revision;
        delete existing.coverMissing;
        delete existing.size;
      } else {
        list.push(entry);
      }
      return list;
    }).then(
      function () {
        console.debug(
          "comics.json 更新成功: " +
            comicName +
            " (page_count=" +
            pageCount +
            ", is_serial=" +
            isSerial +
            ")"
        );

        // 新索引更新成功后，安全处理旧版本目录与历史记录迁移（P1-30）
        if (replacedOldId && replacedOldId !== comicId) {
          // 1. 迁移旧阅读历史指向新 ID
          updateJsonFile(HISTORY_URI, [], function (historyList) {
            const list = Array.isArray(historyList) ? historyList : [];
            const oldHist = list.find(function (item) {
              return (
                item &&
                (item.originalId === replacedOldId ||
                  item.id === "local_" + replacedOldId)
              );
            });
            if (oldHist) {
              oldHist.originalId = comicId;
              oldHist.id = "local_" + comicId;
            }
            return list;
          }).catch(function (err) {
            console.debug("迁移旧阅读历史失败: " + (err && err.code));
          });

          // 2. 安全清理旧漫画目录（彻底根除同名重复导入孤儿目录残留）
          readComics(true).then((current) => {
            const used = new Set(current.reduce((ids, c) => c ? ids.concat(c.storageId ? comicStorageIds(c) : [c.id]) : ids, []));
            replacedRoots.filter((root) => !used.has(root)).forEach((root) => cleanupImportDir("internal://files/" + root));
          }).catch(() => {});
        }
        return { success: true };
      },
      function (e) {
        console.debug("更新 comics.json 失败, code=" + (e && e.code));
        prompt.showToast({ message: "索引更新失败，但文件已保存" });
        return Promise.reject(e);
      }
    );
  }

  function handleDeleteComic(parsed) {
    const comicName = parsed.name || "";
    if (!comicName) {
      prompt.showToast({ message: "删除失败：未提供漫画名称" });
      return;
    }

    prompt.showToast({ message: "正在删除: " + comicName });

    readComics(true).then(
      function (comicsList) {
        if (!Array.isArray(comicsList)) {
          comicsList = [];
        }

        const targets = comicsList.filter(function (c) {
          return c && c.name === comicName;
        });
        if (targets.length !== 1) {
          prompt.showToast({ message: "未找到唯一漫画，请在设备端按条目删除" });
          return;
        }
        deleteComicById(targets[0].id).then((result) => prompt.showToast({ message: result.message }));
      },
      function () {
        prompt.showToast({ message: "读取漫画索引失败" });
      }
    );
  }

  function handleDeleteSource(parsed) {
    const sourceName = parsed.name || "";
    if (!sourceName) {
      prompt.showToast({ message: "删除失败：未提供漫画源名称" });
      return;
    }

    prompt.showToast({ message: "正在删除漫画源: " + sourceName });

    readSources().then(async (list) => {
      const keys = new Set();
      (Array.isArray(list) ? list : []).forEach((s) => {
        if (!s || typeof s !== "object") return;
        const key = Object.keys(s)[0];
        if (key !== "using" && (key === sourceName || (s[key] && s[key].name === sourceName))) keys.add(key);
      });
      if (keys.size !== 1) { prompt.showToast({ message: "未找到唯一漫画源，请在设备端按条目删除" }); return; }
      const result = await deleteSourceByKey(Array.from(keys)[0]);
      if (result.status === "success") bridge.onSourceConfigSaved();
      prompt.showToast({ message: result.message });
    }).catch(() => prompt.showToast({ message: "读取漫画源失败，请重试" }));
  }

  function importFile(state, method, options) {
    const release = state.transaction ? state.transaction.lease.retain() : () => {};
    try {
      file[method]({ ...options, success: (...args) => { release(); options.success(...args); },
        fail: (...args) => { release(); options.fail(...args); } });
    } catch (error) { release(); options.fail(error, 300); }
  }

  // 握手应答：新会话建立时清理残缺的导入状态，并回传快应用设置
  // 顺带交换能力：存下插件 caps（syncWindow 决定方向 B 走滑窗还是旧停等），
  // 并在 hs_pong 里声明本端导入接收窗口（importWindow）
  function handleHandshakePing(parsed) {
    cancelCurrentImport("新握手会话建立");
    // 新会话打断可能在途的滑窗同步：旧会话帧序号对新 frontier 无意义
    stopSync();
    _pluginCaps = parsed && parsed.caps && typeof parsed.caps === "object" ? parsed.caps : null;
    deviceDeletes.beginSession(parsed.session);
    const nativeFetchCap =
      typeof isNativeFetchSupported === "function" ? isNativeFetchSupported() : false;
    interConnect.send({
      data: {
        type: "hs_pong",
        session: parsed.session || "",
        settings: global.APP_SETTING || {},
        caps: {
          importWindow: IMPORT_WINDOW,
          syncSession: true,
          nativeFetch: nativeFetchCap,
          httpImport: nativeFetchCap,
          httpDataSync: nativeFetchCap ? 1 : 0,
          gatewayProtocol: 1,
          deleteProtocol: DELETE_PROTOCOL,
          importResultProtocol: 1,
          importChapterProtocol: CHAPTER_IMPORT_PROTOCOL,
        },
      },
      success: function () {},
      fail: function () {},
    });
  }

  function handleImportComicQuery(parsed) {
    const incomingSession = parsed.sessionId || parsed.session || "";
    const name = parsed.name || "";
    if (
      _lastImportResult &&
      (!incomingSession || _lastImportResult.sessionId === incomingSession) &&
      (!name || _lastImportResult.name === name)
    ) {
      try {
        interConnect.send({
          data: _lastImportResult,
          success: function () {},
          fail: function () {},
        });
      } catch (e) {}
    } else {
      try {
        interConnect.send({
          data: {
            type: "import_comic_result_status",
            sessionId: incomingSession,
            name: name,
            status: "unknown",
          },
          success: function () {},
          fail: function () {},
        });
      } catch (e) {}
    }
  }

  function handleMessage(data) {
    const rawData = data.data;
    if (!rawData) {
      prompt.showToast({ message: "收到空消息" });
      return;
    }

    const parsed = safeJsonParse(rawData, null);
    if (parsed == null || typeof parsed !== "object") {
      // 非 JSON / 标量消息没有可识别格式，直接丢弃，避免噪声覆盖书源 Cookie
      console.debug("丢弃无法识别的消息(非JSON对象)，长度=" + String(rawData).length);
      return;
    }

    const msgType = parsed.type || "(无type)";

    if (msgType === "hs_ping") {
      handleHandshakePing(parsed);
    } else if (msgType === "app_data_ack") {
      // 插件端确认收到 app_data 消息，继续发送下一个
      const ackIndex = parsed.index || 0;
      if (typeof bridge.onAppDataAck === "function") {
        bridge.onAppDataAck(ackIndex);
      }
    } else if (msgType === "sync_ack") {
      // 滑窗会话的累计 ACK：ack = 下一个仍缺失的连续 gseq
      if (
        _syncSender &&
        (_syncWireSession === null ? parsed.session == null : parsed.session === _syncWireSession)
      ) {
        _syncSender.notifyAck(parsed.ack);
      }
    } else if (msgType === "cover_ack") {
      // 插件端拼完整张封面，继续发送下一张
      if (typeof bridge.onCoverAck === "function") {
        bridge.onCoverAck(parsed.name || "");
      }
    } else if (msgType === "source_config" && parsed.configs) {
      handleSourceConfig(parsed.configs);
    } else if (msgType === "cookie") {
      handleCookieMessage(parsed);
    } else if (msgType === "request_data") {
      sendAppData(parsed.session, parsed.http);
    } else if (msgType === "delete_comic") {
      handleDeleteComic(parsed);
    } else if (msgType === "delete_source") {
      handleDeleteSource(parsed);
    } else if (msgType === "delete_item" || msgType === "delete_status") {
      deviceDeletes.handle(parsed, (result) => {
        interConnect.send({ data: result, success() {}, fail() {} });
        if (result.status === "success" && result.kind === "source") bridge.onSourceConfigSaved();
        if (result.status !== "processing" && result.status !== "unknown") prompt.showToast({ message: result.message });
      });
    } else if (msgType === "gateway_bind") {
      handleGatewayBind(parsed, interConnect);
    } else if (msgType === "import_http_task") {
      handleImportHttpTask(parsed, bridge);
    } else if (
      msgType === "import_comic_header" ||
      msgType === "import_comic_chunk" ||
      msgType === "import_comic_done"
    ) {
      handleImportComic(parsed);
    } else if (msgType === "import_comic_query") {
      handleImportComicQuery(parsed);
    } else if (msgType === "import_http_query") {
      handleImportHttpQuery(parsed, interConnect);
    } else {
      // 未知 type 不再兜底进 Cookie，丢弃并记日志
      console.debug("丢弃未知type消息: " + msgType);
    }
  }

  bridge.handleMessage = handleMessage;

  // 由 handleMessage 收到 cover_ack 时调用，喂给当前封面停等队列
  bridge.onCoverAck = function (name) {
    if (_coverFlow) {
      _coverFlow.notifyAck(name);
    }
  };

  bridge.isImporting = function () {
    return !!(_importState && !_importState.cancelled);
  };

  bridge.updateComicsIndex = updateComicsIndex;
  bridge.onSourceConfigSaved = function () {};

  return bridge;
}
