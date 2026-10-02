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
    require(id) {
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
  vm.runInContext(
    httpResponseCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    jsonUtilsCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
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

  return { context, sandbox, deletedFiles, movedFiles, createdDirs, toasts, files };
}

// Valid 4-byte JPEG header
const VALID_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

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

test("gatewaySession: handleImportHttpTask executes task, downloads pages, reports progress, and updates index", async () => {
  const coverTempUri = "internal://cache/temp_cover";
  const p1TempUri = "internal://cache/temp_p1";
  const p2TempUri = "internal://cache/temp_p2";

  const files = new Map([
    [coverTempUri, VALID_JPEG],
    [p1TempUri, VALID_JPEG],
    [p2TempUri, VALID_JPEG],
  ]);

  const postRequests = [];
  let updateIndexCalledWith = null;

  const { context, movedFiles, toasts } = createGatewaySandbox({
    hasNativeFetch: true,
    files,
    fetchHandler(params) {
      if (params.method === "POST") {
        postRequests.push({ url: params.url, data: JSON.parse(params.data || "{}") });
        params.success({ code: 200, statusCode: 200, data: "OK" });
        return;
      }
      if (params.url.endsWith("/control/tasks/task_123")) {
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

  await context.handleImportHttpTask(
    {
      type: "import_http_task",
      taskId: "task_123",
      endpoint: "http://192.168.1.100:51963",
    },
    bridge
  );

  // 1. Files moved to destination
  assert.ok(movedFiles.some((m) => m.src === coverTempUri && m.dst === "internal://files/local_single_1/cover"));
  assert.ok(movedFiles.some((m) => m.src === p1TempUri && m.dst === "internal://files/local_single_1/1"));
  assert.ok(movedFiles.some((m) => m.src === p2TempUri && m.dst === "internal://files/local_single_1/2"));

  // 2. updateComicsIndex called with correct local id and 2 pages
  assert.ok(updateIndexCalledWith != null);
  assert.equal(updateIndexCalledWith.id, "local_single_1");
  assert.equal(updateIndexCalledWith.name, "测试导入漫画");
  assert.equal(updateIndexCalledWith.pageCount, 2);
  assert.equal(updateIndexCalledWith.isSerial, false);

  // 3. POST /progress and POST /result received
  const progressPosts = postRequests.filter((p) => p.url.endsWith("/progress"));
  const resultPosts = postRequests.filter((p) => p.url.endsWith("/result"));

  assert.ok(progressPosts.length >= 2);
  assert.equal(resultPosts.length, 1);
  assert.equal(resultPosts[0].data.success, true);
  assert.equal(resultPosts[0].data.savedPages, 2);

  // 4. Toast notification
  assert.ok(toasts.some((t) => t.includes("导入成功！(2页)")));
});
