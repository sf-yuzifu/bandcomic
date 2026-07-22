import prompt from "@system.prompt";
import file from "@system.file";
import {
  readComics,
  writeComics,
  readSources,
  writeSources,
  writeCookie,
} from "./storage";

function detectImageFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  )
    return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "image/jpeg";
}

function base64Encode(input) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(input);
  const len = bytes.length;
  let result = "";
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;
    result += chars[b1 >> 2];
    result += chars[((b1 & 3) << 4) | (b2 >> 4)];
    result += i + 1 < len ? chars[((b2 & 15) << 2) | (b3 >> 6)] : "=";
    result += i + 2 < len ? chars[b3 & 63] : "=";
  }
  return result;
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

function updateComicsIndexAfterDelete(comicsList, deletedId, comicName) {
  const newList = comicsList.filter((c) => c.id !== deletedId);

  writeComics(newList).then(
    () => {
      prompt.showToast({ message: "已删除: " + comicName });
    },
    ({ code }) => {
      console.log("更新索引失败, code=" + code);
      prompt.showToast({ message: "文件已删除，但索引更新失败" });
    },
  );
}

export function createDataBridge(interConnect) {
  const bridge = {};

  let _coverQueue = [];
  let _coverIndex = 0;
  let _coverName = "";
  let _coverUri = "";
  let _coverTotalBytes = 0;
  let _coverMime = "image/jpeg";
  let _coverPos = 0;

  function readCoverSlice() {
    const READ = 6144;
    const uri = _coverUri;
    const name = _coverName;
    const pos = _coverPos;
    const total = _coverTotalBytes;
    const len = Math.min(READ, total - pos);
    const isFirst = pos === 0;

    file.readArrayBuffer({
      uri: uri,
      position: pos,
      length: len,
      success: function (bufData) {
        if (!bufData.buffer) {
          _coverIndex++;
          setTimeout(function () {
            sendCoversOneByOne();
          }, 300);
          return;
        }

        const bytes = new Uint8Array(bufData.buffer);
        if (isFirst) {
          _coverMime = detectImageFormat(bytes);
        }
        const header = isFirst ? "data:" + _coverMime + ";base64," : "";
        const b64 = base64Encode(bufData.buffer);
        const totalChunks = Math.ceil(total / READ);
        const chunkIndex = Math.floor(pos / READ);

        interConnect.send({
          data: {
            type: "cover_data_chunk",
            name: name,
            index: chunkIndex,
            total: totalChunks,
            data: header + b64,
          },
          success: function () {
            _coverPos = pos + len;
            if (_coverPos >= total) {
              prompt.showToast({
                message:
                  "封面 " +
                  (_coverIndex + 1) +
                  "/" +
                  _coverQueue.length +
                  " (" +
                  totalChunks +
                  "片)",
              });
              _coverIndex++;
              setTimeout(function () {
                sendCoversOneByOne();
              }, 100);
            } else {
              setTimeout(function () {
                readCoverSlice();
              }, 50);
            }
          },
          fail: function () {
            _coverPos = pos + len;
            if (_coverPos >= total) {
              _coverIndex++;
              setTimeout(function () {
                sendCoversOneByOne();
              }, 100);
            } else {
              setTimeout(function () {
                readCoverSlice();
              }, 50);
            }
          },
        });
      },
      fail: function () {
        _coverIndex++;
        setTimeout(function () {
          sendCoversOneByOne();
        }, 30);
      },
    });
  }

  function sendCoversOneByOne() {
    const queue = _coverQueue;
    if (!queue || queue.length === 0) return;

    const idx = _coverIndex;
    if (idx >= queue.length) return;

    const c = queue[idx];

    file.get({
      uri: "internal://files/" + c.id + "/cover",
      success: function (info) {
        _coverName = c.name || "";
        _coverUri = "internal://files/" + c.id + "/cover";
        _coverTotalBytes = info.length || 0;
        _coverMime = "image/jpeg";
        _coverPos = 0;
        readCoverSlice();
      },
      fail: function () {
        _coverIndex = idx + 1;
        setTimeout(function () {
          sendCoversOneByOne();
        }, 30);
      },
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
      message: "发送: comic=" + comics.length + " source=" + sourceList.length,
    });

    // 当前等待 ACK 的消息序号；-1 表示无等待
    let pendingAckIndex = -1;
    // 当前正在发送的消息序号
    let msgIndex = 0;
    // 超时定时器 id
    let ackTimer = null;

    // 监听插件端返回的 ACK（每个消息对应一个序号）
    // 这个函数会作为 bridge 的扩展挂载，由 handleMessage 调用
    function onAppDataAck(ackIndex) {
      if (ackIndex === pendingAckIndex) {
        clearTimeout(ackTimer);
        pendingAckIndex = -1;
        msgIndex++;

        if (msgIndex >= messages.length) {
          // 所有列表消息（header + comic + source + done）都确认完成
          // 现在可以安全开始发封面了
          setTimeout(function () {
            sendCoversOneByOne();
          }, 100);
        } else {
          // 继续发下一个消息
          sendNextMessage();
        }
      }
    }

    // 挂载 ACK 回调，handleMessage 里收到 app_data_ack 时调用
    bridge.onAppDataAck = onAppDataAck;

    function sendNextMessage() {
      if (msgIndex >= messages.length) {
        // 所有列表消息发送完毕，等待插件处理完成后发 ACK 才开始发封面
        // done 消息的 ACK 收到后才能开始发封面，保证插件处理完所有列表数据
        bridge.onAppDataAck = null;
        return;
      }

      const msg = messages[msgIndex];

      pendingAckIndex = msgIndex;

      // 超时保护：5秒未收到 ACK 则继续发下一个（避免死锁）
      ackTimer = setTimeout(function () {
        console.log("消息 " + msgIndex + " ACK 超时，继续发送");
        pendingAckIndex = -1;
        msgIndex++;
        sendNextMessage();
      }, 5000);

      interConnect.send({
        data: msg,
        success: function () {},
        fail: function () {
          // 发送失败也继续，避免卡住
          clearTimeout(ackTimer);
          pendingAckIndex = -1;
          msgIndex++;
          sendNextMessage();
        },
      });
    }

    sendNextMessage();
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
      },
    );
  }

  function sendAppData() {
    prompt.showToast({ message: "request_data，正在读取数据..." });
    _coverIndex = 0;
    _coverQueue = [];
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
          file.get({
            uri: "internal://files/" + c.id,
            recursive: true,
            success: function (fileData) {
              let pageCount = 0;
              let chapterCount = 0;

              if (fileData.subFiles) {
                fileData.subFiles.forEach(function (f) {
                  if (f.type === "dir" && f.subFiles && f.subFiles.length > 0) {
                    chapterCount++;
                  } else if (
                    f.type !== "dir" &&
                    f.uri.split("/").pop() !== "cover"
                  ) {
                    pageCount++;
                  }
                });
              }

              comics.push({
                name: c.name || "",
                page_count: pageCount,
                chapters: chapterCount,
              });

              pending--;
              if (pending === 0) {
                readSourcesAndSend(comics);
              }
            },
            fail: function () {
              comics.push({
                name: c.name || "",
                page_count: 0,
                chapters: 0,
              });

              pending--;
              if (pending === 0) {
                readSourcesAndSend(comics);
              }
            },
          });
        });
      },
      function () {
        readSourcesAndSend([]);
      },
    );
  }

  function handleCookieMessage(rawString, parsedObj) {
    prompt.showToast({ message: "收到Cookie数据" });
    if (!global.cookie) {
      global.cookie = {};
    }

    if (parsedObj) {
      const { type, ...cookieData } = parsedObj;
      Object.assign(global.cookie, cookieData);
    } else {
      const currentSource = global.API_SETTING.using;
      global.cookie[currentSource] = rawString;
    }

    writeCookie(global.cookie).then(
      () => {
        prompt.showToast({ message: "Cookie保存成功！" });
      },
      () => {
        prompt.showToast({ message: "Cookie保存失败" });
      },
    );
  }

  function handleSourceConfig(configs) {
    prompt.showToast({ message: "正在保存漫画源配置..." });

    function applyAndSave(configsToSave) {
      writeSources(configsToSave).then(
        function () {
          configs.forEach(function (newConfig) {
            const key = Object.keys(newConfig)[0];
            global.API_SETTING[key] = newConfig[key];
          });
          bridge.onSourceConfigSaved();
          prompt.showToast({ message: "漫画源配置已保存！" });
        },
        function ({ code }) {
          prompt.showToast({ message: "保存漫画源配置失败: " + code });
        },
      );
    }

    readSources().then(
      function (existingConfigs) {
        configs.forEach(function (newConfig) {
          existingConfigs = replaceIfDuplicate(existingConfigs, newConfig);
        });
        applyAndSave(existingConfigs);
      },
      function () {
        applyAndSave(configs);
      },
    );
  }

  let _importState = null;

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

    const comicId =
      "local_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const dirUri = "internal://files/" + comicId;

    let pageCount = 0;
    const isSerial = mode === "multi";

    if (mode === "single") {
      // files: ["cover", "1", "2", ...], 减去封面就是页数
      pageCount = files.length - 1;
    } else if (chapters) {
      // 所有章节的文件总数，减去第一章节的封面
      let totalFileCount = 0;
      chapters.forEach(function (ch) {
        totalFileCount += (ch.files || []).length;
      });
      pageCount = totalFileCount - 1;
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
      pendingWrites: [],
      failedFiles: 0,
    };

    if (mode === "single") {
      files.forEach(function (f) {
        _importState.files.push(f);
        _importState.totalFiles++;
      });
    } else if (chapters) {
      chapters.forEach(function (ch) {
        const chapName = ch.name || "";
        const chapFiles = ch.files || [];
        chapFiles.forEach(function (f) {
          const fileKey = chapName + "/" + f;
          _importState.files.push(fileKey);
          _importState.totalFiles++;
        });
      });
    }

    prompt.showToast({
      message:
        "开始接收: " + comicName + " (" + _importState.totalFiles + "文件)",
    });

    function flushPendingWrites() {
      if (!_importState || !_importState.pendingWrites) return;
      const pending = _importState.pendingWrites;
      _importState.pendingWrites = [];
      pending.forEach(function (w) {
        writeBinaryFromBase64(
          w.uri,
          w.data,
          function () {
            _importState.completedFiles++;
            if (
              _importState.completedFiles % 5 === 0 ||
              _importState.completedFiles === _importState.totalFiles
            ) {
              prompt.showToast({
                message:
                  "接收 " +
                  _importState.completedFiles +
                  "/" +
                  _importState.totalFiles,
                duration: 500,
              });
            }
          },
          function () {
            _importState.completedFiles++;
            _importState.failedFiles++;
          },
        );
      });
    }

    function onMkdirReady() {
      if (!_importState) return;
      _importState.dirReady = true;
      flushPendingWrites();
    }

    file.mkdir({
      uri: dirUri,
      recursive: false,
      success: function () {
        onMkdirReady();
      },
      fail: function (data, code) {
        if (code === 202) {
          onMkdirReady();
        } else {
          console.log("创建根目录失败: " + code);
          onMkdirReady();
        }
      },
    });

    if (chapters && mode === "multi") {
      chapters.forEach(function (ch) {
        const chapUri = dirUri + "/" + (ch.name || "");
        file.mkdir({
          uri: chapUri,
          recursive: false,
          success: function () {},
          fail: function (data, code) {
            if (code !== 202) {
              console.log("创建章节目录失败: " + chapUri + " code=" + code);
            }
          },
        });
      });
    }

    // 头部就绪确认：插件收到后才开始发分片。
    // 部分平台（如安卓）消息可能乱序，分片先于头部到达会被丢弃
    interConnect.send({
      data: { type: "import_header_ack", name: comicName },
      success: function () {},
      fail: function (data, code) {
        console.log("import_header_ack 发送失败:", code);
      },
    });
  }

  function handleImportComicChunk(parsed) {
    if (!_importState) {
      console.log("收到分片但没有 importState");
      return;
    }

    const comicName = parsed.name || "";
    const fileKey = parsed.file || "";
    const index = parsed.index;
    const total = parsed.total;
    const data = parsed.data || "";

    if (comicName !== _importState.comicName) {
      console.log(
        "分片漫画名不匹配: " + comicName + " vs " + _importState.comicName,
      );
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

      if (_importState.dirReady) {
        writeBinaryFromBase64(
          fileUri,
          fullBase64,
          function () {
            _importState.completedFiles++;
            if (
              _importState.completedFiles % 5 === 0 ||
              _importState.completedFiles === _importState.totalFiles
            ) {
              prompt.showToast({
                message:
                  "接收 " +
                  _importState.completedFiles +
                  "/" +
                  _importState.totalFiles,
                duration: 500,
              });
            }
          },
          function () {
            _importState.completedFiles++;
            _importState.failedFiles++;
          },
        );
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
    if (comicName !== _importState.comicName) return;

    // 等待所有待处理写入完成（简单延迟）
    const failed = _importState.failedFiles || 0;

    updateComicsIndex(
      _importState.comicId,
      _importState.comicName,
      _importState.pageCount,
      _importState.isSerial,
    );

    let msg =
      "导入完成: " +
      _importState.comicName +
      " (" +
      (_importState.totalFiles - failed) +
      "/" +
      _importState.totalFiles +
      "文件)";
    if (failed > 0) {
      msg += "，" + failed + "个失败";
    }
    prompt.showToast({
      message: msg,
    });

    _importState = null;
  }

  function base64DecodeToBytes(base64) {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lookup = {};
    for (let i = 0; i < chars.length; i++) {
      lookup[chars[i]] = i;
    }

    // 统一清洗：只保留 base64 有效字符（含 = 填充符）
    base64 = base64.replace(/[^A-Za-z0-9+/=]/g, "");

    const len = base64.length;
    let padding = 0;
    if (len > 0 && base64.charAt(len - 1) === "=") padding++;
    if (len > 1 && base64.charAt(len - 2) === "=") padding++;

    let bufLen = (len * 3) / 4 - padding;
    bufLen = Math.floor(bufLen);
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

  function writeBinaryFromBase64(fileUri, base64Data, onSuccess, onFail) {
    try {
      const bytes = base64DecodeToBytes(base64Data);
      if (bytes.length === 0) {
        console.log(fileUri + " 解码后为空");
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
              console.log(
                fileUri +
                  " 二进制写入失败 code=" +
                  code2 +
                  " (回退也失败 code=" +
                  code +
                  ")",
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
      console.log("base64解码/写入失败: " + e + " uri=" + fileUri);
      prompt.showToast({ message: "解码异常: " + e, duration: 2000 });
      onFail && onFail();
    }
  }

  function updateComicsIndex(comicId, comicName, pageCount, isSerial) {
    const entry = {
      id: comicId,
      name: comicName,
      page_count: pageCount || 0,
      is_serial: !!isSerial,
    };

    readComics().then(
      function (comicsList) {
        if (!Array.isArray(comicsList)) {
          comicsList = [];
        }

        const existing = comicsList.find(function (c) {
          return c.name === comicName;
        });

        if (existing) {
          existing.id = comicId;
          existing.page_count = entry.page_count;
          existing.is_serial = entry.is_serial;
        } else {
          comicsList.push(entry);
        }

        writeComics(comicsList).then(
          function () {
            console.log(
              "comics.json 更新成功: " +
                comicName +
                " (page_count=" +
                pageCount +
                ", is_serial=" +
                isSerial +
                ")",
            );
          },
          function ({ code }) {
            console.log("更新 comics.json 失败, code=" + code);
            prompt.showToast({ message: "索引更新失败，但文件已保存" });
          },
        );
      },
      function () {
        writeComics([entry]).then(
          function () {
            console.log("comics.json 创建成功");
          },
          function ({ code }) {
            console.log("创建 comics.json 失败, code=" + code);
          },
        );
      },
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
                updateComicsIndexAfterDelete(comicsList, target.id, comicName);
              },
              fail: function () {
                console.log("递归删除失败，直接更新索引");
                updateComicsIndexAfterDelete(comicsList, target.id, comicName);
              },
            });
          },
          fail: function () {
            console.log("文件夹不存在，直接更新索引");
            updateComicsIndexAfterDelete(comicsList, target.id, comicName);
          },
        });
      },
      function () {
        prompt.showToast({ message: "读取漫画索引失败" });
      },
    );
  }

  function handleDeleteSource(parsed) {
    const sourceName = parsed.name || "";
    if (!sourceName) {
      prompt.showToast({ message: "删除失败：未提供漫画源名称" });
      return;
    }

    prompt.showToast({ message: "正在删除漫画源: " + sourceName });

    readSources().then(
      function (sourceList) {
        if (!Array.isArray(sourceList)) {
          sourceList = [];
        }

        const newList = sourceList.filter(function (s) {
          const key = Object.keys(s)[0];
          const info = s[key] || {};
          return key !== sourceName && info.name !== sourceName;
        });

        writeSources(newList).then(
          function () {
            if (global.API_SETTING[sourceName]) {
              delete global.API_SETTING[sourceName];
              if (global.API_SETTING.using === sourceName) {
                const keys = Object.keys(global.API_SETTING).filter(
                  function (k) {
                    return k !== "using";
                  },
                );
                global.API_SETTING.using = keys[0] || "MangaDex";
              }
              bridge.onSourceConfigSaved();
            }

            prompt.showToast({ message: "已删除漫画源: " + sourceName });
          },
          function ({ code }) {
            console.log("更新sources.json失败, code=" + code);
            prompt.showToast({ message: "删除失败，请重试" });
          },
        );
      },
      function () {
        prompt.showToast({ message: "读取漫画源配置失败" });
      },
    );
  }

  // 握手应答：新会话建立时清理残缺的导入状态，并回传快应用设置
  function handleHandshakePing(parsed) {
    if (_importState) {
      console.log("新握手会话，清理未完成的导入状态");
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

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch (e) {
      prompt.showToast({ message: "非JSON，按Cookie处理" });
      handleCookieMessage(rawData, null);
      return;
    }

    const msgType = parsed.type || "(无type)";
    // prompt.showToast({ message: "type=" + msgType, duration: 2000 });

    if (msgType === "hs_ping") {
      handleHandshakePing(parsed);
    } else if (msgType === "app_data_ack") {
      // 插件端确认收到 app_data 消息，继续发送下一个
      const ackIndex = parsed.index || 0;
      if (typeof bridge.onAppDataAck === "function") {
        bridge.onAppDataAck(ackIndex);
      }
    } else if (msgType === "source_config" && parsed.configs) {
      handleSourceConfig(parsed.configs);
    } else if (msgType === "cookie") {
      handleCookieMessage(null, parsed);
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
      prompt.showToast({ message: "未知type，按Cookie处理" });
      handleCookieMessage(null, parsed);
    }
  }

  bridge.handleMessage = handleMessage;

  bridge.onSourceConfigSaved = function () {};

  return bridge;
}
