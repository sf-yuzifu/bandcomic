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

function createGatewaySandbox(options = {}) {
  const {
    hasNativeFetch = true,
    fetchHandler = null,
    files = new Map(),
    toasts = [],
  } = options;

  const deletedFiles = [];
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
    deletedFiles,
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
    gatewayFetchCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    gatewaySessionCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );

  return { context, sandbox, deletedFiles, toasts, files };
}

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
  const files = new Map([[probeTempUri, new Uint8Array(689)]]);

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
  assert.equal(sent[0].probeLength, 689);
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
