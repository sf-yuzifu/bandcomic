import { gatewayFetch, isNativeFetchSupported } from "./gatewayFetch";
import { safeJsonParse } from "./jsonUtils";
import { protectDir, isAlreadyExistsError } from "./storage";
import { createDownloadState, downloadSingleImage } from "./downloadExecutor";

let _gatewaySessionFileModule = null;
try {
  _gatewaySessionFileModule = require("@system.file");
} catch (e) {
  _gatewaySessionFileModule = null;
}

let _gatewaySessionPromptModule = null;
try {
  _gatewaySessionPromptModule = require("@system.prompt");
} catch (e) {
  _gatewaySessionPromptModule = null;
}

function showToast(msg) {
  if (_gatewaySessionPromptModule && typeof _gatewaySessionPromptModule.showToast === "function") {
    _gatewaySessionPromptModule.showToast({ message: msg });
  }
}

let _boundEndpoint = null;
let _boundSession = null;
let _boundInstanceId = null;
let _boundAt = null;

export function isBound() {
  return typeof _boundEndpoint === "string" && _boundEndpoint.length > 0;
}

export function getEndpoint() {
  return _boundEndpoint;
}

export function getSessionInfo() {
  if (!_boundEndpoint) return null;
  return {
    endpoint: _boundEndpoint,
    session: _boundSession,
    instanceId: _boundInstanceId,
    boundAt: _boundAt,
  };
}

export function unbind() {
  _boundEndpoint = null;
  _boundSession = null;
  _boundInstanceId = null;
  _boundAt = null;
}

/**
 * 校验下载临时文件是否真正成功落盘并取得大小，随后清理探针文件
 */
function verifyAndCleanProbeFile(tempUri) {
  return new Promise((resolve) => {
    if (!_gatewaySessionFileModule || !tempUri) {
      resolve(0);
      return;
    }
    _gatewaySessionFileModule.get({
      uri: tempUri,
      success: function (info) {
        const len = (info && info.length) || 0;
        try {
          _gatewaySessionFileModule.delete({ uri: tempUri, fail: function () {} });
        } catch (e) {}
        resolve(len);
      },
      fail: function () {
        resolve(0);
      },
    });
  });
}

/**
 * 处理插件下发的 gateway_bind 绑定消息。
 * 流程：
 * 1. 检查当前设备原生 fetch 能力；若无直接回失败（10 Pro 分流保护）；
 * 2. 原生 GET 请求 /control/health 检查服务身份与实例；
 * 3. 原生 responseType: "file" 下载固定图片探针并验证有效性；
 * 4. 验证通过后固化会话并向插件回复 gateway_bind_result。
 *
 * @param {Object} message - 插件消息
 * @param {Object} interConnect - interconnect 实例，具备 send()
 */
export async function handleGatewayBind(message, interConnect) {
  const session = message.session || "";
  const endpoint = (message.endpoint || "").trim().replace(/\/+$/, "");
  const expectedInstanceId = message.instanceId || null;

  function reply(result) {
    let conn = interConnect;
    if (!conn || typeof conn.send !== "function") {
      if (typeof global !== "undefined" && global.$hub && typeof global.$hub.getConnection === "function") {
        conn = global.$hub.getConnection();
      }
    }
    if (!conn || typeof conn.send !== "function") {
      console.warn("无法回复 gateway_bind_result: 无有效 interconnect 连接");
      return;
    }
    try {
      conn.send({
        data: {
          type: "gateway_bind_result",
          session: session,
          ...result,
        },
        success: function () {
          console.info("已成功发送 gateway_bind_result 应答: session=" + session);
        },
        fail: function (failData, code) {
          console.warn("发送 gateway_bind_result 失败, code=" + code + ", data=" + failData);
        },
      });
    } catch (e) {
      console.error("发送 gateway_bind_result 异常: " + (e && e.message));
    }
  }

  if (!isNativeFetchSupported()) {
    reply({
      success: false,
      nativeFetch: false,
      error: "设备不支持快应用原生 fetch 能力",
    });
    return;
  }

  if (!endpoint || !session) {
    reply({
      success: false,
      nativeFetch: true,
      error: "绑定参数缺失: endpoint 或 session 为空",
    });
    return;
  }

  try {
    // 步骤 1：探测 /control/health
    const healthUrl = endpoint + "/control/health";
    const healthRes = await gatewayFetch({
      url: healthUrl,
      method: "GET",
      responseType: "text",
    });

    if (healthRes.statusCode !== 200) {
      reply({
        success: false,
        nativeFetch: true,
        error: "健康检查返回 HTTP " + healthRes.statusCode,
      });
      return;
    }

    const healthData =
      typeof healthRes.data === "string"
        ? safeJsonParse(healthRes.data, null)
        : healthRes.data;

    if (!healthData || healthData.service !== "bandcomic-local-http") {
      reply({
        success: false,
        nativeFetch: true,
        error: "非法的服务标识，未检测到 bandcomic-local-http",
      });
      return;
    }

    if (expectedInstanceId && healthData.instanceId !== expectedInstanceId) {
      reply({
        success: false,
        nativeFetch: true,
        error: "实例 ID 不匹配: " + healthData.instanceId + " != " + expectedInstanceId,
      });
      return;
    }

    // 步骤 2：下载固定图片探针（验证 responseType: "file"）
    const probeUrl = endpoint + "/control/probe.jpg";
    const probeRes = await gatewayFetch({
      url: probeUrl,
      method: "GET",
      responseType: "file",
    });

    if (probeRes.statusCode !== 200 || !probeRes.data) {
      reply({
        success: false,
        nativeFetch: true,
        error: "探针图片下载失败，HTTP " + probeRes.statusCode,
      });
      return;
    }

    const probeFileLength = await verifyAndCleanProbeFile(probeRes.data);
    if (probeFileLength <= 0) {
      reply({
        success: false,
        nativeFetch: true,
        error: "探针图片文件校验失败: 文件为空或未落盘",
      });
      return;
    }

    // 绑定成功，更新会话
    _boundEndpoint = endpoint;
    _boundSession = session;
    _boundInstanceId = healthData.instanceId;
    _boundAt = Date.now();

    reply({
      success: true,
      nativeFetch: true,
      instanceId: healthData.instanceId,
      endpoint: endpoint,
      probeLength: probeFileLength,
    });

    showToast("本地漫画服务已绑定");
  } catch (err) {
    reply({
      success: false,
      nativeFetch: true,
      error: "连接本地服务失败: " + (err.message || String(err)),
    });
    showToast("本地服务连接失败: " + (err.message || String(err)));
  }
}

/**
 * 处理插件下发的 import_http_task 导入任务。
 * 流程：
 * 1. 经原生 HTTP 获取任务详情 (/control/tasks/<taskId>)；
 * 2. 保护目标漫画目录免遭清理，按章节下载单张图片并校验；
 * 3. 定期回报进度 (/control/tasks/<taskId>/progress)；
 * 4. 全部落盘后写入 comics.json，汇报结果 (/control/tasks/<taskId>/result)。
 */
export async function handleImportHttpTask(message, bridge) {
  const taskId = message.taskId;
  const endpoint = message.endpoint || _boundEndpoint;
  if (!taskId || !endpoint) {
    console.warn("import_http_task 参数缺失: taskId=" + taskId + ", endpoint=" + endpoint);
    return;
  }

  showToast("收到本地导入任务，正在准备下载...");

  // 1. 获取任务详情
  let task;
  try {
    const taskRes = await gatewayFetch({
      url: endpoint + "/control/tasks/" + taskId,
      method: "GET",
      responseType: "text",
    });
    task = typeof taskRes.data === "string" ? safeJsonParse(taskRes.data, null) : taskRes.data;
  } catch (err) {
    console.error("获取任务详情失败: " + err.message);
    showToast("获取任务失败：" + err.message);
    return;
  }

  if (!task || !task.comicId) {
    console.error("非法任务格式: " + JSON.stringify(task));
    return;
  }

  const comicId = "local_" + task.comicId;
  const comicName = task.name || "本地漫画";
  const folderUri = "internal://files/" + comicId;
  const chapters = Array.isArray(task.chapters) ? task.chapters : [];
  const imageProfile = task.imageProfile || {};
  const allowLvgl = !!imageProfile.ifLVGL;
  const isSerial = chapters.length > 1;

  // 保护该目录不被 cleanTempFiles 清理
  const unprotectDir = protectDir(comicId);

  // 确保目录存在
  if (_gatewaySessionFileModule && typeof _gatewaySessionFileModule.mkdir === "function") {
    await new Promise((resolve) => {
      _gatewaySessionFileModule.mkdir({
        uri: folderUri,
        recursive: true,
        success: resolve,
        fail: (data, code) => (isAlreadyExistsError(code) ? resolve() : resolve()),
      });
    });
  }

  const state = createDownloadState({ comicId });
  let savedFiles = {};
  let totalSaved = 0;
  let totalExpected = 0;

  try {
    // 2. 下载封面 (如果提供)
    if (task.coverUrl) {
      const coverUri = folderUri + "/cover";
      try {
        await downloadSingleImage({
          url: task.coverUrl,
          fileUri: coverUri,
          allowLvgl: false,
          fetchFn: gatewayFetch,
          state,
        });
        savedFiles["cover"] = true;
      } catch (e) {
        console.warn("下载封面失败: " + e.message);
      }
    }

    // 3. 逐章节下载
    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      const chNum = chapter.chapterNum || (ci + 1);
      const chTitle = chapter.title || ("第" + chNum + "章");
      const chDirName = isSerial ? `${chNum}　${chTitle}` : "";
      const chapterDir = isSerial ? `${folderUri}/${chDirName}` : folderUri;

      if (isSerial && _gatewaySessionFileModule && typeof _gatewaySessionFileModule.mkdir === "function") {
        await new Promise((resolve) => {
          _gatewaySessionFileModule.mkdir({
            uri: chapterDir,
            recursive: true,
            success: resolve,
            fail: (data, code) => (isAlreadyExistsError(code) ? resolve() : resolve()),
          });
        });
      }

      // 获取章节图片列表
      let photoList;
      try {
        const photoRes = await gatewayFetch({
          url: `${endpoint}/local/photo/${task.comicId}/chapter/${chNum}`,
          method: "GET",
          responseType: "text",
        });
        photoList = typeof photoRes.data === "string" ? safeJsonParse(photoRes.data, null) : photoRes.data;
      } catch (e) {
        console.error("获取章节图片列表失败: " + e.message);
        continue;
      }

      const images = photoList && Array.isArray(photoList.images) ? photoList.images : [];
      totalExpected += images.length;

      for (let pi = 0; pi < images.length; pi++) {
        const imgObj = images[pi];
        const pageUrl = imgObj.url || imgObj;
        const pageNum = pi + 1;
        const pageFileName = `${pageNum}${allowLvgl ? ".bin" : ""}`;
        const fileUri = `${chapterDir}/${pageFileName}`;
        const relativeKey = isSerial ? `${chDirName}/${pageFileName}` : pageFileName;

        try {
          await downloadSingleImage({
            url: pageUrl,
            fileUri: fileUri,
            allowLvgl: allowLvgl,
            fetchFn: gatewayFetch,
            state,
          });
          savedFiles[relativeKey] = true;
          totalSaved++;

          // 汇报进度给插件
          gatewayFetch({
            url: `${endpoint}/control/tasks/${taskId}/progress`,
            method: "POST",
            data: JSON.stringify({ page: totalSaved, total: totalExpected }),
            responseType: "text",
          }).catch(() => {});
        } catch (e) {
          console.warn(`下载第 ${pageNum} 页失败: ` + e.message);
        }
      }
    }

    // 4. 更新 comics.json 索引
    if (bridge && typeof bridge.updateComicsIndex === "function") {
      bridge.updateComicsIndex(
        comicId,
        comicName,
        totalSaved,
        isSerial,
        chapters,
        savedFiles,
        Object.keys(savedFiles)
      );
    }

    // 5. 汇报最终结果给插件
    await gatewayFetch({
      url: `${endpoint}/control/tasks/${taskId}/result`,
      method: "POST",
      data: JSON.stringify({
        success: totalSaved > 0,
        savedPages: totalSaved,
        totalPages: totalExpected,
      }),
      responseType: "text",
    });

    showToast(`《${comicName}》导入成功！(${totalSaved}页)`);
  } catch (err) {
    console.error("任务执行异常: " + err.message);
    gatewayFetch({
      url: `${endpoint}/control/tasks/${taskId}/result`,
      method: "POST",
      data: JSON.stringify({
        success: false,
        savedPages: totalSaved,
        totalPages: totalExpected,
        error: err.message,
      }),
      responseType: "text",
    }).catch(() => {});
    showToast(`《${comicName}》导入中断：${err.message}`);
  } finally {
    unprotectDir();
  }
}
