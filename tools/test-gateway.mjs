import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const gatewayFetchCode = fs.readFileSync(
  new URL("../src/components/gatewayFetch.js", import.meta.url),
  "utf8"
);
const gatewaySessionCode = fs.readFileSync(
  new URL("../src/components/gatewaySession.js", import.meta.url),
  "utf8"
);
const httpResponseCode = fs.readFileSync(
  new URL("../src/components/httpResponse.js", import.meta.url),
  "utf8"
);
const jsonUtilsCode = fs.readFileSync(
  new URL("../src/components/jsonUtils.js", import.meta.url),
  "utf8"
);
const imageFileCode = fs.readFileSync(
  new URL("../src/components/imageFile.js", import.meta.url),
  "utf8"
);
const executorCode = fs.readFileSync(
  new URL("../src/components/downloadExecutor.js", import.meta.url),
  "utf8"
);
const storageCode = fs.readFileSync(
  new URL("../src/components/storage.js", import.meta.url),
  "utf8"
);
const imageUrlCode = fs.readFileSync(
  new URL("../src/components/imageUrl.js", import.meta.url),
  "utf8"
);
const apiCode = fs.readFileSync(new URL("../src/components/api.js", import.meta.url), "utf8");
const comicImportCode = fs.readFileSync(new URL("../src/components/comicImport.js", import.meta.url), "utf8");

function createGatewaySandbox(options = {}) {
  const {
    hasNativeFetch = true,
    fetchHandler = null,
    files = new Map(),
    toasts = [],
  } = options;

  const deletedFiles = [];
  const movedFiles = [];
  const createdDirs = [];

  const systemFetch = hasNativeFetch
    ? {
        fetch(params) {
          if (fetchHandler) {
            fetchHandler(params);
          }
        },
      }
    : null;

  const file = {
    readText(opts) {
      if (files.has(opts.uri)) opts.success({ text: files.get(opts.uri) });
      else opts.fail("not found", 301);
    },
    writeText(opts) {
      files.set(opts.uri, opts.text);
      opts.success();
    },
    access(opts) {
      if (files.has(opts.uri)) opts.success();
      else opts.fail("not found", 301);
    },
    rmdir(opts) {
      deletedFiles.push(opts.uri);
      for (const uri of files.keys()) {
        if (uri.startsWith(opts.uri + "/")) files.delete(uri);
      }
      if (opts.success) opts.success();
    },
    get(opts) {
      if (files.has(opts.uri)) {
        opts.success({ length: files.get(opts.uri).length });
      } else {
        opts.fail("file not found", 301);
      }
    },
    delete(opts) {
      deletedFiles.push(opts.uri);
      files.delete(opts.uri);
      if (opts.success) opts.success();
    },
    mkdir(opts) {
      createdDirs.push(opts.uri);
      if (opts.success) opts.success();
    },
    move(opts) {
      movedFiles.push({ src: opts.srcUri, dst: opts.dstUri });
      if (files.has(opts.srcUri)) {
        files.set(opts.dstUri, files.get(opts.srcUri));
        files.delete(opts.srcUri);
      }
      if (opts.success) opts.success();
    },
    readArrayBuffer(opts) {
      if (files.has(opts.uri)) {
        const full = files.get(opts.uri);
        const slice = full.slice(opts.position, opts.position + opts.length);
        opts.success({ buffer: slice.buffer });
      } else {
        opts.fail("not found", 301);
      }
    },
  };

  const sandbox = {
    global: { APP_SETTING: { imageUsePng: false, imagePreTranscode: false } },
    URL,
    require(id) {
      if (id === "@system.router") return { push: (params) => { sandbox.lastRoute = params; } };
      if (id === "@system.fetch") {
        if (systemFetch) return systemFetch;
        throw new Error("Cannot find module '@system.fetch'");
      }
      if (id === "@system.file") {
        return file;
      }
      if (id === "@system.prompt") {
        return {
          showToast(opts) {
            toasts.push(opts.message);
          },
        };
      }
      throw new Error("Unknown module: " + id);
    },
    console: { debug() {}, info() {}, warn() {}, error() {} },
    Promise,
    Date,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
    deletedFiles,
    movedFiles,
    createdDirs,
    toasts,
    files,
  };

  const context = vm.createContext(sandbox);

  // Run modules
  vm.runInContext(imageUrlCode.replace(/^export /gm, "") +
    "\nglobal.$img = { addUrlParam, appendCoverSuffix, appendLvglSuffix };", context);
  vm.runInContext(
    httpResponseCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    jsonUtilsCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(fs.readFileSync(new URL("../src/components/sourceConfig.js", import.meta.url), "utf8").replace(/^export /gm, ""), context);
  vm.runInContext(apiCode.replace(/^import .*;\r?\n/gm, "").replace(/^export \{[^\n]*\n/gm, "")
    .replace(/^export /gm, ""), context);
  vm.runInContext(
    imageFileCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    storageCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    executorCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    gatewayFetchCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    gatewaySessionCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(comicImportCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);

  return { context, sandbox, deletedFiles, movedFiles, createdDirs, toasts, files };
}

// Valid 4-byte JPEG header
const VALID_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

for (const preTranscode of [false, true]) {
  test(`gatewaySession: transport preserves download page URLs without renaming (bin=${preTranscode})`, async () => {
    const requests = [];
    const { context } = createGatewaySandbox({ fetchHandler: (params) => requests.push(params) });
    const endpoint = "http://host:51963";
    const ctx = { endpoint };
    const cover = endpoint + "/images/selected-cover?width=80&quality=72&ifPNG=1#/_icf_cover_1";
    const page = endpoint + "/images/first-page?width=360&quality=72&revision=rev_1" +
      (preTranscode ? "&ifLVGL=1#/_icf_page_2.bin" : "#/_icf_page_2");
    const responses = [];
    for (const url of [cover, page]) {
      context.requestDownload(ctx, { url, responseType: "file", success: (r) => responses.push(r) });
    }
    assert.deepEqual(requests.map((r) => r.url), [cover, page]);
    const urls = requests.map((r) => new URL(r.url));
    const names = urls.map((u) => u.hash.slice(2));
    assert.equal(new Set(names).size, 2);
    assert.equal(names[0], "_icf_cover_1");
    assert.equal(names[1], "_icf_page_2" + (preTranscode ? ".bin" : ""));
    assert.equal(urls[0].searchParams.get("width"), "80");
    assert.equal(urls[0].searchParams.get("ifLVGL"), null);
    assert.equal(urls[0].searchParams.get("ifPNG"), "1");
    assert.equal(urls[1].searchParams.get("width"), "360");
    assert.equal(urls[1].searchParams.get("quality"), "72");
    assert.equal(urls[1].searchParams.get("revision"), "rev_1");
    assert.equal(urls[1].searchParams.get("ifLVGL"), preTranscode ? "1" : null);
    // Model firmware which derives the temp path from the trailing URL filename.
    const nativeFiles = new Map();
    requests.forEach((r, i) => {
      const uri = "internal://cache/" + names[i];
      nativeFiles.set(uri, i === 0 ? "COVER" : "PAGE_" + i);
      r.success({ code: 200, data: uri });
    });
    assert.equal(nativeFiles.get(responses[0].data), "COVER");
  });
}

test("gatewaySession: replacing a local book migrates its history cover before deleting the old folder", async () => {
  const files = new Map([
    ["internal://files/comics.json", JSON.stringify([
      { id: "local_old", name: "Book" }, { id: "local_new", name: "Book" },
      { id: "online_other", name: "Book" },
    ])],
    ["internal://files/history.json", JSON.stringify([
      { id: "local_local_old", originalId: "local_old", local: true, page: 3,
        cover: "internal://files/local_old/cover", coverLocal: "internal://files/local_old/cover" },
      { id: "online_other", originalId: "other", cover: "https://other/cover" },
    ])],
    ["internal://files/local_old/cover", VALID_JPEG],
    ["internal://files/local_new/cover", VALID_JPEG],
  ]);
  const { context, deletedFiles } = createGatewaySandbox({ files });
  await context.commitDownload({ localId: "local_new", savedPages: 1, totalPages: 1 });
  const history = JSON.parse(files.get("internal://files/history.json"));
  assert.equal(history[0].cover, "internal://files/local_new/cover");
  assert.equal(history[0].coverLocal, undefined);
  assert.equal(history[0].originalId, "local_new");
  assert.equal(history[0].page, 3);
  assert.equal(history[1].cover, "https://other/cover");
  assert.ok(deletedFiles.includes("internal://files/local_old"));
  assert.ok(files.has(history[0].cover));
});

test("gatewayFetch: rejects immediately when device lacks native fetch", async () => {
  const { context } = createGatewaySandbox({ hasNativeFetch: false });
  assert.equal(context.isNativeFetchSupported(), false);

  await assert.rejects(
    () => context.gatewayFetch({ url: "http://127.0.0.1:51963/control/health" }),
    /does not support native fetch/
  );
});

test("gatewayFetch: text fetch resolves on 200 with code and statusCode", async () => {
  const { context } = createGatewaySandbox({
    hasNativeFetch: true,
    fetchHandler(params) {
      params.success({
        code: 200,
        data: JSON.stringify({ service: "bandcomic-local-http" }),
        headers: { "content-type": "application/json" },
      });
    },
  });

  const res = await context.gatewayFetch({ url: "http://127.0.0.1:51963/control/health" });
  assert.equal(res.statusCode, 200);
  assert.match(res.data, /bandcomic-local-http/);
});

test("gatewayFetch: file fetch cleans up temp file when response is not HTTP success", async () => {
  const { context, deletedFiles } = createGatewaySandbox({
    hasNativeFetch: true,
    fetchHandler(params) {
      params.success({
        code: 404,
        data: "internal://cache/err_temp_file",
        headers: {},
      });
    },
  });

  await assert.rejects(
    () =>
      context.gatewayFetch({
        url: "http://127.0.0.1:51963/control/probe.jpg",
        responseType: "file",
      }),
    /404/
  );
  assert.ok(deletedFiles.includes("internal://cache/err_temp_file"));
});

test("gatewaySession: handleGatewayBind rejects on devices without native fetch", async () => {
  const { context } = createGatewaySandbox({ hasNativeFetch: false });
  const sent = [];
  const interConnect = {
    send(opt) {
      sent.push(opt.data);
    },
  };

  await context.handleGatewayBind(
    {
      type: "gateway_bind",
      session: "bind-001",
      endpoint: "http://192.168.1.100:51963",
      instanceId: "inst-1",
    },
    interConnect
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "gateway_bind_result");
  assert.equal(sent[0].session, "bind-001");
  assert.equal(sent[0].success, false);
  assert.equal(sent[0].nativeFetch, false);
  assert.equal(context.isBound(), false);
});

test("gatewaySession: handleGatewayBind succeeds when health and probe file verify", async () => {
  const probeTempUri = "internal://cache/probe_temp_file";
  const files = new Map([[probeTempUri, VALID_JPEG]]);

  const { context, deletedFiles, toasts } = createGatewaySandbox({
    hasNativeFetch: true,
    files,
    fetchHandler(params) {
      if (params.url.endsWith("/control/health")) {
        params.success({
          code: 200,
          data: JSON.stringify({
            service: "bandcomic-local-http",
            instanceId: "inst-1",
            port: 51963,
          }),
        });
      } else if (params.url.endsWith("/control/probe.jpg")) {
        params.success({
          code: 200,
          data: probeTempUri,
        });
      }
    },
  });

  const sent = [];
  const interConnect = {
    send(opt) {
      sent.push(opt.data);
    },
  };

  await context.handleGatewayBind(
    {
      type: "gateway_bind",
      session: "bind-002",
      endpoint: "http://192.168.1.100:51963/",
      instanceId: "inst-1",
    },
    interConnect
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "gateway_bind_result");
  assert.equal(sent[0].session, "bind-002");
  assert.equal(sent[0].success, true);
  assert.equal(sent[0].nativeFetch, true);
  assert.equal(sent[0].probeLength, VALID_JPEG.length);
  assert.equal(sent[0].endpoint, "http://192.168.1.100:51963");

  assert.equal(context.isBound(), true);
  assert.equal(context.getEndpoint(), "http://192.168.1.100:51963");
  assert.equal(context.getSessionInfo().session, "bind-002");
  assert.ok(deletedFiles.includes(probeTempUri)); // probe temp file was verified and cleaned up
  assert.ok(toasts.some((t) => t.includes("已绑定")));
});

test("gatewaySession: handleGatewayBind fails if service identity or instanceId mismatches", async () => {
  const { context } = createGatewaySandbox({
    hasNativeFetch: true,
    fetchHandler(params) {
      params.success({
        code: 200,
        data: JSON.stringify({
          service: "different-service",
          instanceId: "inst-other",
        }),
      });
    },
  });

  const sent = [];
  const interConnect = {
    send(opt) {
      sent.push(opt.data);
    },
  };

  await context.handleGatewayBind(
    {
      type: "gateway_bind",
      session: "bind-003",
      endpoint: "http://192.168.1.100:51963",
      instanceId: "inst-1",
    },
    interConnect
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].success, false);
  assert.match(sent[0].error, /非法的服务标识/);
  assert.equal(context.isBound(), false);
});

test("gatewaySession: bound task opens download UI once and reports only confirmed pages", async () => {
  const coverTempUri = "internal://cache/temp_cover";
  const p1TempUri = "internal://cache/temp_p1";
  const p2TempUri = "internal://cache/temp_p2";

  const files = new Map([
    [coverTempUri, VALID_JPEG],
    [p1TempUri, VALID_JPEG],
    [p2TempUri, VALID_JPEG],
  ]);

  const postRequests = [];
  const getRequests = [];
  let updateIndexCalledWith = null;

  const { context, movedFiles, toasts } = createGatewaySandbox({
    hasNativeFetch: true,
    files,
    fetchHandler(params) {
      if (params.method === "POST") {
        postRequests.push({ url: params.url, data: JSON.parse(params.data || "{}") });
        params.success({ code: 200, statusCode: 200, data: "{}" });
        return;
      }
      getRequests.push(params.url);
      if (params.url.endsWith("/control/health")) {
        params.success({ code: 200, data: JSON.stringify({ service: "bandcomic-local-http", instanceId: "test" }) });
      } else if (params.url.endsWith("/control/probe.jpg")) {
        params.success({ code: 200, data: p1TempUri });
      } else if (params.url.endsWith("/control/tasks/task_123")) {
        params.success({
          code: 200,
          data: JSON.stringify({
            taskId: "task_123",
            comicId: "single_1",
            name: "测试导入漫画",
            revision: "rev_1",
            coverUrl: "http://192.168.1.100:51963/local/album/single_1/cover",
            chapters: [{ chapterNum: 1, title: "第1章", pageCount: 2 }],
            imageProfile: { width: 480, quality: 50, ifPNG: false, ifLVGL: false },
          }),
        });
      } else if (params.url.endsWith("/config")) {
        params.success({ code: 200, data: JSON.stringify({ LocalUpload: {
          apiUrl: "http://192.168.1.100:51963", detailPath: "/catalog/<id>", photoPath: "/chapters/<id>/<chapter>",
        } }) });
      } else if (params.url.endsWith("/catalog/single_1")) {
        params.success({ code: 200, data: JSON.stringify({ item_id: "single_1", name: "标准详情名",
          page_count: 2, total_chapters: 1, cover: "http://192.168.1.100:51963/selected-cover" }) });
      } else if (params.url.endsWith("/local/photo/single_1/chapter/1")) {
        params.success({
          code: 200,
          data: JSON.stringify({
            title: "第1章",
            images: [
              { url: "http://192.168.1.100:51963/local/photo/single_1/chapter/1/1.jpg" },
              { url: "http://192.168.1.100:51963/local/photo/single_1/chapter/1/2.jpg" },
            ],
          }),
        });
      } else if (params.url.endsWith("/cover")) {
        params.success({ code: 200, statusCode: 200, data: coverTempUri });
      } else if (params.url.endsWith("/1.jpg")) {
        params.success({ code: 200, statusCode: 200, data: p1TempUri });
      } else if (params.url.endsWith("/2.jpg")) {
        params.success({ code: 200, statusCode: 200, data: p2TempUri });
      }
    },
  });

  const bridge = {
    updateComicsIndex(id, name, pageCount, isSerial, chapters, savedFiles) {
      updateIndexCalledWith = { id, name, pageCount, isSerial, chapters, savedFiles };
    },
  };

  await context.handleGatewayBind({ session: "test", endpoint: "http://192.168.1.100:51963" }, { send() {} });
  await context.handleImportHttpTask(
    {
      type: "import_http_task",
      taskId: "task_123",
      endpoint: "http://192.168.1.100:51963",
    },
    bridge
  );

  assert.equal(context.lastRoute.uri, "/pages/download");
  assert.equal(context.lastRoute.params.gatewayTaskId, "task_123");
  assert.equal(movedFiles.length, 0);
  assert.equal(updateIndexCalledWith, null);
  const task = context.getDownloadContext("task_123");
  assert.equal(task.detail.cover, "http://192.168.1.100:51963/selected-cover");
  assert.equal(task.detail.name, "标准详情名");
  assert.equal(task.source.photoPath, "/chapters/<id>/<chapter>");
  assert.ok(getRequests.indexOf("http://192.168.1.100:51963/config") < getRequests.indexOf("http://192.168.1.100:51963/catalog/single_1"));
  await context.handleImportHttpTask({ taskId: "task_123" });
  assert.equal(context.getDownloadContext("task_123"), task);
  context.pageSaved(task, 1, 1);
  context.pageSaved(task, 1, 1);
  context.pageSaved(task, 1, 2);
  await context.finishDownload(task, true);

  // 3. POST /progress and POST /result received
  const progressPosts = postRequests.filter((p) => p.url.endsWith("/progress"));
  const resultPosts = postRequests.filter((p) => p.url.endsWith("/result"));

  assert.equal(progressPosts.length, 1);
  assert.equal(resultPosts.length, 1);
  assert.equal(resultPosts[0].data.success, true);
  assert.equal(resultPosts[0].data.savedPages, 2);

  assert.ok(toasts.some((t) => t.includes("已绑定")));
});

for (const scenario of ["empty-cover", "bad-config", "detail-error", "wrong-id", "unbind-during-detail"]) {
  test(`gatewaySession: standard source preparation handles ${scenario}`, async () => {
    const endpoint = "http://host:1234";
    const files = new Map([["internal://cache/probe", VALID_JPEG]]);
    let delayedDetail;
    const { context } = createGatewaySandbox({ files, fetchHandler(params) {
      let data;
      let code = 200;
      if (params.url.endsWith("/probe.jpg")) {
        params.success({ code, data: "internal://cache/probe" });
        return;
      } else if (params.url.endsWith("/health")) {
        data = { service: "bandcomic-local-http" };
      } else if (params.url.endsWith("/task_test")) {
        data = { comicId: "book", sourceKey: "TestSource", chapters: [{ chapterNum: 1, pageCount: 1 }],
          coverUrl: endpoint + "/wrong-task-cover" };
      } else if (params.url.endsWith("/config")) {
        data = { TestSource: { apiUrl: scenario === "bad-config" ? "http://other:999" : endpoint,
          detailPath: "/details/<id>", photoPath: "/pages/<id>/<chapter>" } };
      } else if (params.url.endsWith("/details/book")) {
        if (scenario === "unbind-during-detail") { delayedDetail = params; return; }
        code = scenario === "detail-error" ? 500 : 200;
        data = { item_id: scenario === "wrong-id" ? "other" : "book", name: "Book", page_count: 1, cover: "" };
      } else if (params.method === "POST") {
        data = {};
      } else throw new Error("Unexpected URL: " + params.url);
      params.success({ code, data: JSON.stringify(data) });
    } });
    await context.handleGatewayBind({ endpoint, session: "bind" }, { send() {} });
    const loading = context.handleImportHttpTask({ taskId: "task_test" });
    if (scenario === "unbind-during-detail") {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(delayedDetail);
      context.unbind();
      delayedDetail.success({ code: 200, data: JSON.stringify({ item_id: "book", name: "Book", page_count: 1, cover: "" }) });
    }
    await loading;
    if (scenario === "empty-cover") {
      assert.equal(context.lastRoute.uri, "/pages/download");
      const task = context.getDownloadContext("task_test");
      assert.equal(task.detail.cover, "", "must not fall back to a stale task coverUrl");
      assert.equal(task.detail.total_chapters, 1);
      assert.equal(task.source.photoPath, "/pages/<id>/<chapter>");
    } else {
      assert.equal(context.lastRoute, undefined);
      assert.equal(context.getDownloadContext("task_test"), null);
    }
  });
}

test("gatewaySession: HTTP-9-C retries /result on network failure and flushes pending result on rebind or query", async () => {
  const endpoint = "http://host:1234";
  const files = new Map([["internal://cache/probe", VALID_JPEG]]);
  let attempts = 0;
  const resultPosts = [];

  const { context } = createGatewaySandbox({ files, fetchHandler(params) {
    if (params.url.endsWith("/probe.jpg")) {
      params.success({ code: 200, data: "internal://cache/probe" });
      return;
    } else if (params.url.endsWith("/health")) {
      params.success({ code: 200, data: JSON.stringify({ service: "bandcomic-local-http" }) });
      return;
    } else if (params.url.endsWith("/result")) {
      attempts++;
      resultPosts.push(JSON.parse(params.data));
      if (attempts === 1) {
        // 第一次报错
        params.fail({ message: "Network timeout" }, 500);
        return;
      }
      params.success({ code: 200, data: JSON.stringify({ code: 200, message: "OK" }) });
      return;
    }
    params.success({ code: 200, data: "{}" });
  } });

  const fakeContext = {
    endpoint,
    taskId: "task_retry",
    savedPages: 3,
    totalPages: 3,
    ended: false,
    report: Promise.resolve(),
  };

  await context.finishDownload(fakeContext, true);
  assert.equal(attempts, 2, "sendResultWithRetry should retry after first failure and succeed on second");
  assert.equal(resultPosts.length, 2);
  assert.equal(resultPosts[1].success, true);
  assert.equal(resultPosts[1].savedPages, 3);
  const pending = context.getPendingResult();
  assert.ok(pending);
  assert.equal(pending.reported, true);

  // 测试 handleImportHttpQuery 响应查询
  let sentData = null;
  const mockConn = {
    send(msg) { sentData = msg.data; },
  };
  context.handleImportHttpQuery({ taskId: "task_retry" }, mockConn);
  assert.ok(sentData);
  assert.equal(sentData.type, "import_http_result");
  assert.equal(sentData.taskId, "task_retry");
  assert.equal(sentData.success, true);
  assert.equal(sentData.savedPages, 3);

  // 测试未知 taskId 的查询
  let unknownData = null;
  context.handleImportHttpQuery({ taskId: "task_unknown" }, { send(msg) { unknownData = msg.data; } });
  assert.ok(unknownData);
  assert.equal(unknownData.type, "import_http_result_status");
  assert.equal(unknownData.status, "unknown");
});

test("gatewaySession: HTTP-9-D rejects concurrent tasks and reports rejection without disturbing active download", async () => {
  const endpoint = "http://host:1234";
  const files = new Map([["internal://cache/probe", VALID_JPEG]]);
  const resultPosts = [];

  const { context } = createGatewaySandbox({ files, fetchHandler(params) {
    if (params.url.endsWith("/probe.jpg")) {
      params.success({ code: 200, data: "internal://cache/probe" });
      return;
    } else if (params.url.endsWith("/health")) {
      params.success({ code: 200, data: JSON.stringify({ service: "bandcomic-local-http" }) });
      return;
    } else if (params.url.endsWith("/config")) {
      params.success({ code: 200, data: JSON.stringify({ LocalUpload: { apiUrl: endpoint, detailPath: "/details/<id>", photoPath: "/pages/<id>/<chapter>" } }) });
      return;
    } else if (params.url.endsWith("/details/comic1")) {
      params.success({ code: 200, data: JSON.stringify({ item_id: "comic1", name: "Comic 1", page_count: 1, total_chapters: 1, cover: "" }) });
      return;
    } else if (params.url.endsWith("/task_1")) {
      params.success({ code: 200, data: JSON.stringify({ comicId: "comic1", sourceKey: "LocalUpload", chapters: [{ chapterNum: 1, pageCount: 1 }] }) });
      return;
    } else if (params.url.endsWith("/result")) {
      resultPosts.push(JSON.parse(params.data));
      params.success({ code: 200, data: JSON.stringify({ code: 200, message: "OK" }) });
      return;
    }
    params.success({ code: 200, data: "{}" });
  } });

  await context.handleGatewayBind({ endpoint, session: "bind" }, { send() {} });
  await context.handleImportHttpTask({ taskId: "task_1" });
  assert.equal(context.hasActiveDownload(), true);

  // 尝试并发传入新任务 task_2
  await context.handleImportHttpTask({ taskId: "task_2" });
  // task_1 仍然活跃，且收到 task_2 的拒绝结果上报
  assert.equal(context.hasActiveDownload(), true);
  const task2Result = resultPosts.find((p) => p.error && p.error.includes("已有 HTTP 下载任务正在进行"));
  assert.ok(task2Result, "task_2 should be rejected and report error to plugin");
  assert.equal(task2Result.success, false);
});

test("gatewaySession: HTTP-9-E enforces cold-boot readiness and OOBE/update gates", async () => {
  const endpoint = "http://host:1234";
  const files = new Map([["internal://cache/probe", VALID_JPEG]]);
  const resultPosts = [];

  const { context } = createGatewaySandbox({ files, fetchHandler(params) {
    if (params.url.endsWith("/probe.jpg")) {
      params.success({ code: 200, data: "internal://cache/probe" });
      return;
    } else if (params.url.endsWith("/health")) {
      params.success({ code: 200, data: JSON.stringify({ service: "bandcomic-local-http" }) });
      return;
    } else if (params.url.endsWith("/result")) {
      resultPosts.push(JSON.parse(params.data));
      params.success({ code: 200, data: JSON.stringify({ code: 200, message: "OK" }) });
      return;
    }
    params.success({ code: 200, data: "{}" });
  } });

  await context.handleGatewayBind({ endpoint, session: "bind" }, { send() {} });

  // 1. OOBE 门禁：oobeDone 为 false 时应拒绝
  context.global.APP_SETTING = { oobeDone: false };
  context.global.bootSettled = true;
  await context.handleImportHttpTask({ taskId: "task_oobe" });
  assert.equal(context.hasActiveDownload(), false);
  const oobeResult = resultPosts.find((p) => p.error && p.error.includes("首次设置引导"));
  assert.ok(oobeResult, "should report oobe rejection");
  assert.equal(oobeResult.success, false);

  // 2. 更新门禁：updatePageShowing 为 true 时应拒绝
  context.global.APP_SETTING = { oobeDone: true };
  context.global.updatePageShowing = true;
  await context.handleImportHttpTask({ taskId: "task_update" });
  assert.equal(context.hasActiveDownload(), false);
  const updateResult = resultPosts.find((p) => p.error && p.error.includes("更新引导"));
  assert.ok(updateResult, "should report update rejection");
  assert.equal(updateResult.success, false);

  // 3. 冷启动等待：bootSettled 为 false 时等待并放行
  context.global.updatePageShowing = false;
  context.global.bootSettled = false;
  let settledCalled = false;
  setTimeout(() => {
    settledCalled = true;
    context.global.bootSettled = true;
    if (context.global.onBootSettled) context.global.onBootSettled();
  }, 50);

  const readyPromise = context.ensureAppReady();
  await readyPromise;
  assert.equal(settledCalled, true, "ensureAppReady should wait for boot settlement");
});

test("gatewaySession: HTTP-9-B resumes interrupted task and reuses valid stage", async () => {
  const endpoint = "http://host:1234";
  const files = new Map([["internal://cache/probe", VALID_JPEG]]);
  const resultPosts = [];

  const { context } = createGatewaySandbox({ files, fetchHandler(params) {
    if (params.url.endsWith("/probe.jpg")) {
      params.success({ code: 200, data: "internal://cache/probe" });
      return;
    } else if (params.url.endsWith("/health")) {
      params.success({ code: 200, data: JSON.stringify({ service: "bandcomic-local-http" }) });
      return;
    } else if (params.url.endsWith("/config")) {
      params.success({ code: 200, data: JSON.stringify({ LocalUpload: { apiUrl: endpoint, detailPath: "/details/<id>", photoPath: "/pages/<id>/<chapter>" } }) });
      return;
    } else if (params.url.endsWith("/details/comic_resume")) {
      params.success({ code: 200, data: JSON.stringify({ item_id: "comic_resume", name: "断点续传漫", page_count: 3, total_chapters: 1, cover: "" }) });
      return;
    } else if (params.url.endsWith("/task_resume_1")) {
      params.success({ code: 200, data: JSON.stringify({
        taskId: "task_resume_1", comicId: "comic_resume", bookId: "book_resume", revision: "rev_1",
        importChapterProtocol: 1, operation: "replace_book", isSerial: true,
        imageProfile: { width: 480, quality: 50, ifPng: false, ifLvgl: false },
        chapters: [{ chapterNum: 1, title: "第1章", pageCount: 3 }]
      }) });
      return;
    } else if (params.url.endsWith("/task_resume_2")) {
      // 同作品、同版本重试任务
      params.success({ code: 200, data: JSON.stringify({
        taskId: "task_resume_2", comicId: "comic_resume", bookId: "book_resume", revision: "rev_1",
        importChapterProtocol: 1, operation: "replace_book", isSerial: true,
        imageProfile: { width: 480, quality: 50, ifPng: false, ifLvgl: false },
        chapters: [{ chapterNum: 1, title: "第1章", pageCount: 3 }]
      }) });
      return;
    } else if (params.url.endsWith("/result")) {
      resultPosts.push(JSON.parse(params.data));
      params.success({ code: 200, data: JSON.stringify({ code: 200, message: "OK" }) });
      return;
    }
    params.success({ code: 200, data: "{}" });
  } });

  context.global.bootSettled = true;
  context.global.APP_SETTING = { oobeDone: true };
  await context.handleGatewayBind({ endpoint, session: "bind" }, { send() {} });

  // 1. 首次任务：保存了 2 页后中断
  await context.handleImportHttpTask({ taskId: "task_resume_1" });
  const task1 = context.getDownloadContext("task_resume_1");
  assert.ok(task1);
  const stage1Id = task1.localId;
  context.pageSaved(task1, 1, 1);
  context.pageSaved(task1, 1, 2);
  // 中断
  await context.finishDownload(task1, false, "网络超时中断");
  assert.equal(context.hasActiveDownload(), false);

  // 2. 再次重试任务（同一任务或同书新任务）：复用 stage1Id
  await context.handleImportHttpTask({ taskId: "task_resume_2" });
  const task2 = context.getDownloadContext("task_resume_2");
  assert.ok(task2);
  assert.equal(task2.localId, stage1Id, "should reuse the same stageId from previous attempt");

  // 继续保存（前两页跳过，保存剩余第 3 页）并提交完成
  const chDir = "internal://files/" + stage1Id + "/1　第1章";
  files.set(chDir + "/1", VALID_JPEG);
  files.set(chDir + "/2", VALID_JPEG);
  files.set(chDir + "/3", VALID_JPEG);
  context.pageSaved(task2, 1, 1);
  context.pageSaved(task2, 1, 2);
  context.pageSaved(task2, 1, 3);
  await context.commitDownload(task2);
  await context.finishDownload(task2, true);
  assert.equal(context.hasActiveDownload(), false);
  const finalResult = resultPosts.find((p) => p.success === true);
  assert.ok(finalResult);
  assert.equal(finalResult.savedPages, 3);
});



