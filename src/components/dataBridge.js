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
} from "./storage";
import { safeJsonParse } from "./jsonUtils";
import { base64Encode, base64ToBytes } from "./base64";
import { ensureUsingSourceValid } from "./api";
import { createStopWaitQueue } from "./stopWaitQueue";

// 封面推送读盘切片（手表→手机）：保持 6144 小切片求稳；
// 反方向（插件→设备 fetch 分片）才用 24K，见 interconnfetch.js MAX_CHUNK_SIZE
const COVER_READ_CHUNK_SIZE = 6144;
const ACK_TIMEOUT = 5000;
const COVER_ACK_TIMEOUT = 3000;
const COVER_MAX_RETRY = 2;
const SLICE_MAX_RETRY = 3;
const COVER_PACING_MS = 20;

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

function replaceIfDuplicate(configArray, newConfigObject) {
  const newKey = Object.keys(newConfigObject)[0];
  const singleConfig = { [newKey]: newConfigObject[newKey] };
  let found = false;

  for (let i = 0; i < configArray.length; i++) {
    const existingKey = Object.keys(configArray[i])[0];
    if (existingKey === newKey) {
      configArray[i] = singleConfig;
      found = true;
      break;
    }
  }

  if (!found) {
    configArray.push(singleConfig);
  }

  return configArray;
}

function updateComicsIndexAfterDelete(deletedId, comicName) {
  updateJsonFile(COMICS_URI, [], function (comicsList) {
    const list = Array.isArray(comicsList) ? comicsList : [];
    return list.filter((c) => c.id !== deletedId);
  }).then(
    () => {
      prompt.showToast({ message: "已删除: " + comicName });
    },
    (e) => {
      console.debug("更新索引失败, code=" + (e && e.code));
      prompt.showToast({ message: "文件已删除，但索引更新失败" });
    }
  );
}

export function createDataBridge(interConnect) {
  const bridge = {};

  let _coverQueue = [];
  let _coverDoneSent = false;
  let _coverFlow = null; // 当前封面停等队列（createStopWaitQueue 实例）
  let _coverMime = "image/jpeg";

  // 单张封面的发送动作：file.get 拿大小 → 逐切片连发（片间节流 COVER_PACING_MS），
  // 全部发完 ctx.sent() 进入等 cover_ack；任一环失败 ctx.failed() 跳过本张。
  // 切片级失败重试（SLICE_MAX_RETRY）留在本函数内部，与队列的整包重发正交
  function sendCoverItem(c, ctx) {
    const uri = "internal://files/" + c.id + "/cover";
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

  function sendAppDataBatched(comics, sourceList) {
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
        bridge.onAppDataAck = null;
        // 列表消息全部确认（或兜底跳过）后，安全开始发封面
        setTimeout(function () {
          sendCoversOneByOne();
        }, 100);
      },
    });

    // 挂载 ACK 回调，handleMessage 里收到 app_data_ack 时调用
    bridge.onAppDataAck = flow.notifyAck;
  }

  function readSourcesAndSend(comics) {
    readSources().then(
      function (rawSources) {
        let sourceList = [];
        if (Array.isArray(rawSources)) {
          sourceList = rawSources.map(function (s) {
            const key = Object.keys(s)[0];
            const info = s[key];
            return {
              name: (info && info.name) || key,
              apiUrl: (info && info.apiUrl) || "",
            };
          });
        }

        sendAppDataBatched(comics, sourceList);
      },
      function () {
        sendAppDataBatched(comics, []);
      }
    );
  }

  function sendAppData() {
    _coverQueue = [];
    _coverDoneSent = false;
    // 新一轮同步：取消上一轮可能仍在途的封面队列，其迟到回调全部过期
    if (_coverFlow) {
      _coverFlow.cancel();
      _coverFlow = null;
    }
    readComics().then(
      function (comicsList) {
        if (!Array.isArray(comicsList)) {
          comicsList = [];
        }

        _coverQueue = comicsList;

        if (comicsList.length === 0) {
          readSourcesAndSend([]);
          return;
        }

        const comics = [];
        let pending = comicsList.length;

        comicsList.forEach(function (c) {
          const pushMeta = function (pageCount, chapterCount) {
            comics.push({
              name: c.name || "",
              page_count: pageCount,
              chapters: chapterCount,
            });

            pending--;
            if (pending === 0) {
              readSourcesAndSend(comics);
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

          file.get({
            uri: "internal://files/" + c.id,
            recursive: true,
            success: function (fileData) {
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
        readSourcesAndSend([]);
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
        configs.forEach(function (newConfig) {
          const key = Object.keys(newConfig)[0];
          global.API_SETTING[key] = newConfig[key];
        });
        bridge.onSourceConfigSaved();
        prompt.showToast({ message: "漫画源配置已保存！" });
      },
      function (e) {
        prompt.showToast({ message: "保存漫画源配置失败: " + (e && e.code) });
      }
    );
  }

  let _importState = null;

  // 启动一个文件的异步落盘：回调只认捕获的 state（不碰全局 _importState），
  // done 先到时收尾会等 inflightWrites 归零，回调不会再撞上 null
  function startImportWrite(state, uri, data) {
    state.inflightWrites++;
    writeBinaryFromBase64(
      uri,
      data,
      function () {
        state.completedFiles++;
        state.inflightWrites--;
        if (state.completedFiles % 5 === 0 || state.completedFiles === state.totalFiles) {
          prompt.showToast({
            message: "接收 " + state.completedFiles + "/" + state.totalFiles,
            duration: 500,
          });
        }
        maybeFinalizeImport(state);
      },
      function () {
        state.completedFiles++;
        state.failedFiles++;
        state.inflightWrites--;
        maybeFinalizeImport(state);
      }
    );
  }

  // done 已收到且所有写入（在途 + 待写）都完成后才真正收尾
  function maybeFinalizeImport(state) {
    if (!state || !state.doneReceived) return;
    if (!state.dirReady) return;
    if (state.pendingWrites.length > 0) return;
    if (state.inflightWrites > 0) return;
    finalizeImport(state);
  }

  function finalizeImport(state) {
    const failed = state.failedFiles || 0;

    updateComicsIndex(
      state.comicId,
      state.comicName,
      state.pageCount,
      state.isSerial,
      state.chapters
    );

    let msg =
      "导入完成: " +
      state.comicName +
      " (" +
      (state.totalFiles - failed) +
      "/" +
      state.totalFiles +
      "文件)";
    if (failed > 0) {
      msg += "，" + failed + "个失败";
    }
    prompt.showToast({
      message: msg,
    });

    if (_importState === state) {
      _importState = null;
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

  function handleImportComicHeader(parsed) {
    const comicName = parsed.name || "";
    const mode = parsed.mode || "single";
    const files = parsed.files || [];
    const chapters = parsed.chapters || null;

    if (!comicName) {
      prompt.showToast({ message: "导入失败：未提供漫画名称" });
      return;
    }

    const comicId = "local_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const dirUri = "internal://files/" + comicId;

    let pageCount = 0;
    const isSerial = mode === "multi";

    if (mode === "single") {
      // files: ["cover", "1", "2", ...], 减去封面就是页数
      pageCount = files.length - 1;
    } else if (chapters) {
      // 所有章节的文件总数（多章模式书级封面独立于 chapters 发送，不参与页数统计）
      let totalFileCount = 0;
      chapters.forEach(function (ch) {
        totalFileCount += (ch.files || []).length;
      });
      pageCount = totalFileCount;
    }

    _importState = {
      comicId: comicId,
      dirUri: dirUri,
      comicName: comicName,
      mode: mode,
      files: [],
      chapters: chapters,
      buffers: {},
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
    };

    if (mode === "single") {
      files.forEach(function (f) {
        _importState.files.push(f);
        _importState.totalFiles++;
      });
    } else if (chapters) {
      chapters.forEach(function (ch, ci) {
        // 与插件端归一化规则镜像（trim 后为空则回退 "第N章"），两端独立计算保证一致
        const chapName = (ch.name || "").trim() || "第" + (ci + 1) + "章";
        const chapFiles = ch.files || [];
        chapFiles.forEach(function (f) {
          const fileKey = chapName + "/" + f;
          _importState.files.push(fileKey);
          _importState.totalFiles++;
        });
      });
      // 多章模式书级封面：插件独立于 chapters 发送（用户可选，可能没有），
      // 加入验收清单避免分片被当未知拒收，但不计入文件数（见 handleImportComicChunk）
      _importState.files.push("cover");
    }

    prompt.showToast({
      message: "开始接收: " + comicName + " (" + _importState.totalFiles + "文件)",
    });

    function flushPendingWrites() {
      const state = _importState;
      if (!state || !state.pendingWrites) return;
      const pending = state.pendingWrites;
      state.pendingWrites = [];
      pending.forEach(function (w) {
        if (w.isCover) {
          // 封面不参与文件计数
          writeBinaryFromBase64(
            w.uri,
            w.data,
            function () {},
            function () {}
          );
          return;
        }
        startImportWrite(state, w.uri, w.data);
      });
    }

    // 目录就绪计数归零：dirReady 置位，冲刷待写队列，并尝试收尾
    function onOneDirReady() {
      const state = _importState;
      if (!state) return;
      state.pendingDirs--;
      if (state.pendingDirs > 0) return;
      state.dirReady = true;
      flushPendingWrites();
      maybeFinalizeImport(state);
    }

    // 根目录就绪后再建章节目录（recursive:false 要求父目录存在，否则章节 mkdir 会失败丢文件）
    function onRootDirReady() {
      const state = _importState;
      if (!state) return;
      if (state.mode === "multi" && state.chapters && state.chapters.length > 0) {
        state.pendingDirs = state.chapters.length;
        state.chapters.forEach(function (ch, ci) {
          // 与分片键构造同源归一化，保证 mkdir 落点与写入路径一致
          const chapName = (ch.name || "").trim() || "第" + (ci + 1) + "章";
          file.mkdir({
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

    file.mkdir({
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
    interConnect.send({
      data: { type: "import_header_ack", name: comicName },
      success: function () {},
      fail: function (data, code) {
        console.debug("import_header_ack 发送失败:", code);
      },
    });
  }

  function handleImportComicChunk(parsed) {
    if (!_importState) {
      console.debug("收到分片但没有 importState");
      return;
    }

    const comicName = parsed.name || "";
    const fileKey = parsed.file || "";
    const index = parsed.index;
    const total = parsed.total;
    const data = parsed.data || "";

    if (comicName !== _importState.comicName) {
      // 漫画名含特殊字符时传输中可能被转义导致不一致
      // _importState 是单例，本身即代表当前唯一导入会话，名不匹配只告警不丢弃
      console.debug("分片漫画名不匹配: " + comicName + " vs " + _importState.comicName);
    }

    // 严格匹配：fileKey 必须在头部声明的文件清单内，否则视为异常分片
    if (_importState.files.indexOf(fileKey) === -1) {
      console.debug("未知分片文件: " + fileKey);
      // 仍需回 ACK，避免插件端超时重传死循环
      interConnect.send({
        data: {
          type: "import_chunk_ack",
          name: comicName,
          file: fileKey,
          index: index,
        },
      });
      return;
    }

    if (!_importState.buffers[fileKey]) {
      _importState.buffers[fileKey] = {
        chunks: new Array(total),
        received: 0,
        total: total,
      };
    }

    const buf = _importState.buffers[fileKey];
    if (buf.chunks[index]) {
      // 重复分片：数据忽略，但仍需重发 ACK，否则插件端超时重传会死循环
      interConnect.send({
        data: {
          type: "import_chunk_ack",
          name: comicName,
          file: fileKey,
          index: index,
        },
      });
      return;
    }

    buf.chunks[index] = data;
    buf.received++;

    // 收到每个分片后发送 ACK，告知插件可以发下一片
    interConnect.send({
      data: {
        type: "import_chunk_ack",
        name: comicName,
        file: fileKey,
        index: index,
      },
    });

    if (buf.received === buf.total) {
      const fullBase64 = buf.chunks.join("");
      const fileUri = _importState.dirUri + "/" + fileKey;
      delete _importState.buffers[fileKey];

      // 多章模式书级封面不参与文件计数（插件端可选发送，缺失不报错）；
      // 单本模式的 cover 在 header files 清单内，走正常计数路径
      const isUncountedCover = _importState.mode === "multi" && fileKey === "cover";
      if (isUncountedCover) {
        if (_importState.dirReady) {
          writeBinaryFromBase64(
            fileUri,
            fullBase64,
            function () {},
            function () {}
          );
        } else {
          _importState.pendingWrites.push({ uri: fileUri, data: fullBase64, isCover: true });
        }
        return;
      }

      if (_importState.dirReady) {
        startImportWrite(_importState, fileUri, fullBase64);
      } else {
        _importState.pendingWrites.push({
          uri: fileUri,
          data: fullBase64,
        });
      }
    }
  }

  function handleImportComicDone(parsed) {
    if (!_importState) return;

    const comicName = parsed.name || "";
    if (comicName !== _importState.comicName) {
      // 与分片同理：名不匹配只告警，按当前导入会话完成收尾
      console.debug("完成消息漫画名不匹配: " + comicName + " vs " + _importState.comicName);
    }

    // 只标记 done 到达：base64 落盘是异步的，可能还有在途/待写文件，
    // 等 maybeFinalizeImport 确认全部写完才收尾，否则回调访问 _importState 会 TypeError、
    // 失败统计也会漏记在途写入
    _importState.doneReceived = true;
    maybeFinalizeImport(_importState);
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

  function updateComicsIndex(comicId, comicName, pageCount, isSerial, chapters) {
    // 章节元数据：导入视为全部下载完成；size 缺失，离线页首次进入会扫描回写真实值
    let chaptersMeta;
    if (isSerial && Array.isArray(chapters)) {
      chaptersMeta = chapters.map(function (ch, i) {
        const count = (ch.files || []).length;
        return { num: i + 1, name: ch.name || "", page_count: count, downloaded: count };
      });
    } else {
      chaptersMeta = [{ num: 0, name: "", page_count: pageCount || 0, downloaded: pageCount || 0 }];
    }

    const entry = {
      id: comicId,
      name: comicName,
      page_count: pageCount || 0,
      is_serial: !!isSerial,
      chapters: chaptersMeta,
      downloaded_at: Date.now(),
    };

    // 串行队列内读-改-写 + 原子落盘，避免与下载/阅读路径并发时丢条目
    updateJsonFile(COMICS_URI, [], function (comicsList) {
      const list = Array.isArray(comicsList) ? comicsList : [];
      const existing = list.find(function (c) {
        return c.name === comicName;
      });

      if (existing) {
        existing.id = comicId;
        existing.page_count = entry.page_count;
        existing.is_serial = entry.is_serial;
        existing.chapters = entry.chapters;
        existing.downloaded_at = entry.downloaded_at;
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
      },
      function (e) {
        console.debug("更新 comics.json 失败, code=" + (e && e.code));
        prompt.showToast({ message: "索引更新失败，但文件已保存" });
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

    readComics().then(
      function (comicsList) {
        if (!Array.isArray(comicsList)) {
          comicsList = [];
        }

        const target = comicsList.find(function (c) {
          return c.name === comicName;
        });
        if (!target) {
          prompt.showToast({ message: "未找到漫画: " + comicName });
          return;
        }

        const folderUri = "internal://files/" + target.id + "/";

        file.access({
          uri: folderUri,
          success: function () {
            file.rmdir({
              uri: folderUri,
              recursive: true,
              success: function () {
                updateComicsIndexAfterDelete(target.id, comicName);
              },
              fail: function () {
                console.debug("递归删除失败，直接更新索引");
                updateComicsIndexAfterDelete(target.id, comicName);
              },
            });
          },
          fail: function () {
            console.debug("文件夹不存在，直接更新索引");
            updateComicsIndexAfterDelete(target.id, comicName);
          },
        });
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

    updateJsonFile(SOURCES_URI, [], function (sourceList) {
      const list = Array.isArray(sourceList) ? sourceList : [];
      return list.filter(function (s) {
        const key = Object.keys(s)[0];
        const info = s[key] || {};
        return key !== sourceName && info.name !== sourceName;
      });
    }).then(
      function () {
        if (global.API_SETTING[sourceName]) {
          delete global.API_SETTING[sourceName];
          ensureUsingSourceValid();
          bridge.onSourceConfigSaved();
        }

        prompt.showToast({ message: "已删除漫画源: " + sourceName });
      },
      function (e) {
        console.debug("更新sources.json失败, code=" + (e && e.code));
        prompt.showToast({ message: "删除失败，请重试" });
      }
    );
  }

  // 握手应答：新会话建立时清理残缺的导入状态，并回传快应用设置
  function handleHandshakePing(parsed) {
    if (_importState) {
      console.debug("新握手会话，清理未完成的导入状态");
      _importState = null;
    }
    interConnect.send({
      data: {
        type: "hs_pong",
        session: parsed.session || "",
        settings: global.APP_SETTING || {},
      },
      success: function () {},
      fail: function () {},
    });
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
      sendAppData();
    } else if (msgType === "delete_comic") {
      handleDeleteComic(parsed);
    } else if (msgType === "delete_source") {
      handleDeleteSource(parsed);
    } else if (
      msgType === "import_comic_header" ||
      msgType === "import_comic_chunk" ||
      msgType === "import_comic_done"
    ) {
      handleImportComic(parsed);
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

  bridge.onSourceConfigSaved = function () {};

  return bridge;
}
