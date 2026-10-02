// Execute the real bridge receiver/writer with a delayed Vela file API and fake clock.
// No device, network, application files or build outputs are touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { crc32 } from "node:zlib";

const source = fs.readFileSync(
  new URL("../src/components/interconnfetch.js", import.meta.url),
  "utf8"
);
const base64 = fs.readFileSync(new URL("../src/components/base64.js", import.meta.url), "utf8");
const httpResponse = fs.readFileSync(new URL("../src/components/httpResponse.js", import.meta.url), "utf8");
const CHUNK = 32768;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness(bufferType = "both", direct = false) {
  const sent = [],
    calls = [],
    pending = [],
    deleted = [],
    logs = [];
  const files = new Map(),
    timers = new Map();
  let now = 0,
    timerSeq = 0,
    activity = null;
  let inFlight = 0,
    maxInFlight = 0;
  const nativeRequests = [];
  const bytesOf = (buffer) =>
    Buffer.from(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer);
  const file = {
    writeArrayBuffer(options) {
      const arrayBuffer = options.buffer instanceof ArrayBuffer;
      calls.push({ length: options.buffer.byteLength, arrayBuffer, position: options.position });
      if ((bufferType === "array" && !arrayBuffer) || (bufferType === "uint8" && arrayBuffer)) {
        options.fail("unsupported buffer", 202);
        return;
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.push({
        finish(error) {
          inFlight--;
          if (error) {
            options.fail("disk error", error);
            return;
          }
          const old = files.get(options.uri) || Buffer.alloc(0);
          if (options.position !== undefined && options.position >= old.length) {
            options.fail("position must be inside file", 202);
            return;
          }
          const bytes = bytesOf(options.buffer);
          let result;
          if (options.position !== undefined) {
            result = Buffer.alloc(Math.max(old.length, options.position + bytes.length));
            old.copy(result);
            bytes.copy(result, options.position);
          } else {
            result = options.append ? Buffer.concat([old, bytes]) : bytes;
          }
          files.set(options.uri, result);
          options.success();
        },
      });
    },
    delete({ uri }) {
      deleted.push(uri);
      files.delete(uri);
    },
  };
  const conn = {
    send(options) {
      sent.push(options.data);
      if (options.data.tag === "__hs__" && options.data.count === 0) {
        queueMicrotask(() => context.hooks.client._onFetchMessage({ tag: "__hs__", count: 1 }));
      }
      if (h.onSend) h.onSend(options.data, options);
    },
  };
  const sandbox = {
    require: (name) => {
      if (name === "@system.file") return file;
      if (name === "@system.fetch" && direct) return { fetch: (options) => { nativeRequests.push(options); } };
      throw new Error("unavailable");
    },
    global: { APP_SETTING: { preferBridge: !direct } },
    process: { env: { NODE_ENV: "test" } },
    safeJsonParse: (text, fallback) => {
      try {
        return JSON.parse(text);
      } catch {
        return fallback;
      }
    },
    getConnection: () => conn,
    registerFetchHandler: () => {},
    registerActivityHandler: (fn) => {
      activity = fn;
    },
    Uint8Array,
    Int8Array,
    Uint32Array,
    ArrayBuffer,
    Map,
    Promise,
    console: { debug: (message) => logs.push(message) },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout: (fn, delay) => {
      const id = ++timerSeq;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    httpResponse.replace(/^export /gm, "") + "\n" + base64.replace(/^export /gm, "") +
      "\n" +
      source.replace(/^import .*;\r?\n/gm, "").replace("export default {", "globalThis.api = {") +
      "\nglobalThis.hooks = { client: interconnClient, createFileWriter, caps: LOCAL_CAPS };",
    context
  );
  context.hooks.client._init();
  context.hooks.client.open = true;
  const h = {
    sent,
    calls,
    pending,
    deleted,
    files,
    nativeRequests,
    logs,
    api: context.api,
    hooks: context.hooks,
    onSend: null,
    get maxInFlight() {
      return maxInFlight;
    },
    message(message) {
      if (activity) activity();
      context.hooks.client._onFetchMessage(message);
    },
    async complete(error) {
      assert.ok(pending.length, "expected a native write");
      pending.shift().finish(error);
      await tick();
    },
    async drain() {
      for (let n = 0; n < 2000; n++) {
        await tick();
        if (!pending.length) return;
        await h.complete();
      }
      throw new Error("write queue did not drain");
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await tick();
      }
      now = target;
      await tick();
    },
  };
  return h;
}

for (const mode of ["v1", "v3", "v4"]) {
  for (const status of [401, 403, 404, 500, 502]) {
    test(`${mode}: HTTP ${status} is rejected at the header before any file write`, async () => {
      const h = harness();
      const events = [];
      let complete = 0;
      const task = h.api.fetch({ url: "https://example.test/error", responseType: "file",
        success: () => events.push({ success: true }),
        fail: (message, code) => events.push({ message, code }), complete: () => complete++ });
      await tick();
      const { id } = h.sent.find((message) => message.tag === "fetch");
      const body = Buffer.from("<html>not an image</html>");
      h.message({ tag: "fetch", id, resp: { ok: false, status, raw: true,
        bodyEncoding: "base64", body: body.toString("base64"), ack: true,
        ...(mode === "v3" ? { chunked: true, chunkCount: 1, chunkSize: CHUNK }
          : mode === "v4" ? { stream: true } : {}) } });
      await task;
      h.message({ tag: mode === "v4" ? "fetch-stream" : "fetch-chunk", id, seq: 0,
        data: body.toString("base64"), offset: 0 });
      await tick();
      assert.equal(events.length, 1);
      assert.equal(events[0].code, status);
      assert.match(events[0].message, new RegExp("HTTP " + status));
      assert.equal(complete, 1);
      assert.equal(h.calls.length, 0);
      assert.equal(h.files.size, 0);
      assert.equal(h.hooks.client.requests.size, 0);
      if (mode === "v4") assert.ok(h.sent.some((message) => message.tag === "fetch-stream-cancel"));
      assert.equal(h.sent.some((message) => /ack$/.test(message.tag)), false);
    });
  }
}

for (const status of [401, 403, 404, 500, 302, 304]) {
  test(`native HTTP ${status}: code is recognized, cache file cleaned and complete stays single`, async () => {
    const h = harness("both", true);
    const events = [];
    let complete = 0;
    await h.api.fetch({ url: "https://example.test/error", responseType: "file",
      success: () => events.push("success"), fail: (message, code) => events.push(code),
      complete: () => complete++ });
    const uri = "internal://cache/native_error";
    h.files.set(uri, Buffer.from("<html>error</html>"));
    h.nativeRequests[0].success({ code: status, data: uri });
    h.nativeRequests[0].complete();
    assert.deepEqual(events, [status]);
    assert.deepEqual(h.deleted, [uri]);
    assert.equal(h.files.size, 0);
    assert.equal(complete, 1);
  });
}

test("native final 200 after redirect passes through with both code and statusCode", async () => {
  const h = harness("both", true);
  const events = [];
  await h.api.fetch({ url: "https://example.test/redirect", responseType: "file",
    success: (response) => events.push(response), fail: () => assert.fail("unexpected failure") });
  const uri = "internal://cache/image";
  h.files.set(uri, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  h.nativeRequests[0].success({ code: 200, data: uri });
  assert.equal(events[0].code, 200);
  assert.equal(events[0].statusCode, 200);
  assert.equal(h.deleted.length, 0);
});

test("native HTTP JSON errors remain responses for health and detail validation", async () => {
  const h = harness("both", true);
  const events = [];
  await h.api.fetch({ url: "https://example.test/config", responseType: "json",
    success: (response) => events.push(response), fail: () => assert.fail("unexpected transport error") });
  h.nativeRequests[0].success({ code: 500, data: { message: "error" } });
  assert.equal(events[0].statusCode, 500);
  assert.equal(events[0].data.message, "error");
});

test("bridge final 200 after redirect is accepted and followRedirects remains enabled", async () => {
  const h = harness();
  const events = [];
  const task = h.api.fetch({ url: "https://example.test/redirect", responseType: "file",
    success: (response) => events.push(response), fail: () => assert.fail("unexpected failure") });
  await tick();
  const request = h.sent.find((message) => message.tag === "fetch");
  assert.equal(request.options.followRedirects, true);
  const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  h.message({ tag: "fetch", id: request.id, resp: {
    status: 200, ok: true, raw: true, bodyEncoding: "base64", body: body.toString("base64") } });
  await h.drain();
  await task;
  assert.deepEqual(h.files.get(events[0].data), body);
  assert.equal(events[0].statusCode, 200);
});

async function start(h, version = 4, extra = {}) {
  const events = [];
  const task = h.api.fetch({
    url: "https://example.test/image",
    responseType: "file",
    success: (response) => events.push({ kind: "success", response }),
    fail: (message) => events.push({ kind: "fail", message }),
  });
  await tick();
  const request = h.sent.filter((message) => message.tag === "fetch").at(-1);
  assert.ok(request);
  const id = request.id;
  h.message({
    tag: "fetch",
    id,
    resp: {
      raw: true,
      ack: true,
      status: 200,
      bodyEncoding: "base64",
      ...(version === 4
        ? { stream: true }
        : { chunked: true, chunkSize: CHUNK, chunkCount: 4, totalBytes: CHUNK * 4 }),
      ...extra,
    },
  });
  return { id, task, events, version };
}

function frame(h, transfer, seq, bytes, options = {}) {
  h.message({
    tag: transfer.version === 4 ? "fetch-stream" : "fetch-chunk",
    id: transfer.id,
    seq,
    data: bytes.toString("base64"),
    offset: seq * CHUNK,
    ...(transfer.version === 4 ? { crc32: crc32(bytes).toString(16).padStart(8, "0") } : {}),
    ...options,
  });
}

function eof(h, transfer, seq, totalBytes) {
  h.message({ tag: "fetch-stream", id: transfer.id, seq, final: true, totalBytes });
}

function ack(h, transfer) {
  return (
    h.sent.filter((message) => message.id === transfer.id && /ack$/.test(message.tag)).at(-1)
      ?.ack || 0
  );
}

function assertSuccess(h, transfer, expected) {
  assert.equal(transfer.events.length, 1);
  assert.equal(transfer.events[0].kind, "success");
  assert.deepEqual(h.files.get(transfer.events[0].response.data), expected);
  assert.equal(h.hooks.client.requests.size, 0);
  assert.equal(h.maxInFlight, 1);
}

for (const version of [3, 4]) {
  test(`v${version}: stalled disk does not ACK or admit unlimited frames`, async () => {
    const h = harness();
    const t = await start(
      h,
      version,
      version === 3 ? { chunkCount: 20, totalBytes: CHUNK * 20 } : {}
    );
    for (let seq = 0; seq < 20; seq++) frame(h, t, seq, Buffer.alloc(CHUNK, seq));
    const req = h.hooks.client.requests.get(t.id);
    assert.equal(ack(h, t), 0);
    assert.equal(req.received, 4);
    assert.equal(Object.keys(req.chunkBuffer).length, 4);
    assert.equal(h.calls.length, 1);
    assert.ok(req.sink.stats.peakBytes <= 256 * 1024);
    await h.advance(20000);
    assert.equal(t.events[0].kind, "fail");
    assert.equal(h.hooks.client.requests.size, 0);
    await h.complete();
    assert.equal(h.files.size, 0, "late write must not recreate the partial file");
    assert.equal(h.calls.length, 1, "cancelled queued frames must never start");
  });

  test(`v${version}: merge only arrived contiguous chunks, preserve bytes`, async () => {
    const h = harness();
    const t = await start(h, version);
    const pieces = Array.from({ length: 4 }, (_, seq) => Buffer.alloc(CHUNK, seq + 1));
    pieces.forEach((bytes, seq) => frame(h, t, seq, bytes));
    assert.equal(h.calls.length, 1, "first chunk starts immediately");
    await h.complete();
    assert.equal(h.calls[1].length, 65536, "two already-arrived adjacent chunks share a write");
    if (version === 4) eof(h, t, 4, CHUNK * 4);
    await h.drain();
    assertSuccess(h, t, Buffer.concat(pieces));
    assert.equal(h.calls.length, 3);
    assert.equal(ack(h, t), version === 4 ? 5 : 4);
  });

  test(`v${version}: reverse arrival, duplicate before/after ACK, strict position semantics`, async () => {
    const h = harness();
    const t = await start(h, version);
    const pieces = Array.from({ length: 4 }, (_, seq) => Buffer.alloc(CHUNK, seq + 7));
    for (const seq of [3, 2, 1, 0, 3, 0]) frame(h, t, seq, pieces[seq]);
    const req = h.hooks.client.requests.get(t.id);
    const writer = req.sink;
    await h.complete();
    assert.equal(ack(h, t), 0, "written chunk 3 cannot confirm the hole");
    await h.drain();
    const writes = h.calls.length;
    frame(h, t, 0, pieces[0]);
    if (version === 4) eof(h, t, 4, CHUNK * 4);
    await tick();
    assertSuccess(h, t, Buffer.concat(pieces));
    assert.equal(h.calls.length, writes);
    assert.equal(writer.stats.zeroBytes, CHUNK * 3);
    assert.ok(writer.stats.peakBytes <= 256 * 1024);
  });
}

test("old v4 without offset: later chunk remains pending until really appended; early EOF", async () => {
  const h = harness();
  const t = await start(h);
  const a = Buffer.from("first"),
    b = Buffer.from("second");
  frame(h, t, 1, b, { offset: undefined });
  eof(h, t, 2, a.length + b.length);
  assert.equal(h.calls.length, 0);
  assert.equal(ack(h, t), 0);
  assert.equal(t.events.length, 0);
  assert.equal(h.hooks.client.requests.size, 1);
  frame(h, t, 0, a, { offset: undefined });
  await h.drain();
  assertSuccess(h, t, Buffer.concat([a, b]));
  assert.equal(ack(h, t), 3);
});

test("v4 variable-length offsets and short tail retain exact bytes", async () => {
  const h = harness();
  const t = await start(h);
  const pieces = [Buffer.from("abc"), Buffer.from("defgh"), Buffer.from("i")];
  frame(h, t, 2, pieces[2], { offset: 8 });
  frame(h, t, 0, pieces[0], { offset: 0 });
  frame(h, t, 1, pieces[1], { offset: 3 });
  eof(h, t, 3, 9);
  await h.drain();
  assertSuccess(h, t, Buffer.concat(pieces));
});

test("CRC failure asks for retransmission, duplicate CRC failures cannot renew timeout", async () => {
  const h = harness();
  const t = await start(h);
  const data = Buffer.from("CRC checked");
  frame(h, t, 0, data, { crc32: "00000000" });
  assert.equal(h.calls.length, 0);
  assert.equal(ack(h, t), 0);
  frame(h, t, 0, data);
  eof(h, t, 1, data.length);
  await h.drain();
  assertSuccess(h, t, data);

  const slow = harness();
  const stalled = await start(slow);
  for (let i = 0; i < 3; i++) {
    await slow.advance(6000);
    frame(slow, stalled, 0, data, { crc32: "00000000" });
  }
  await slow.advance(2000);
  assert.equal(stalled.events[0].kind, "fail");
});

test("EOF does not remove a request while native write is pending", async () => {
  const h = harness();
  const t = await start(h);
  frame(h, t, 0, Buffer.from("image"));
  eof(h, t, 1, 5);
  assert.equal(h.hooks.client.requests.size, 1);
  assert.equal(t.events.length, 0);
  await h.advance(20000);
  assert.equal(t.events[0].kind, "fail");
  assert.ok(h.sent.some((message) => message.tag === "fetch-stream-cancel"));
  await h.complete();
  assert.equal(h.files.size, 0);
});

test("successful disk progress keeps a transfer alive beyond 20 seconds total", async () => {
  const h = harness();
  const t = await start(h);
  const pieces = Array.from({ length: 4 }, (_, seq) => Buffer.alloc(CHUNK, seq + 1));
  pieces.forEach((bytes, seq) => frame(h, t, seq, bytes));
  await h.advance(12000);
  await h.complete();
  eof(h, t, 4, CHUNK * 4);
  await h.advance(12000);
  await h.complete();
  await h.advance(12000);
  await h.complete();
  assertSuccess(h, t, Buffer.concat(pieces));
});

test("hung native write blocks new file transfers, but not JSON or recovery after late completion", async () => {
  const h = harness();
  const t = await start(h);
  frame(h, t, 0, Buffer.from("old"));
  await h.advance(20000);
  const fetchCount = h.sent.filter((message) => message.tag === "fetch").length;
  let failure;
  await h.api.fetch({
    url: "next",
    responseType: "file",
    fail: (message) => {
      failure = message;
    },
  });
  assert.match(failure, /previous file write/);
  assert.equal(h.sent.filter((message) => message.tag === "fetch").length, fetchCount);
  let json;
  const jsonTask = h.api.fetch({
    url: "metadata",
    responseType: "json",
    success: (response) => {
      json = response.data;
    },
  });
  await tick();
  const id = h.sent.filter((message) => message.tag === "fetch").at(-1).id;
  h.message({ tag: "fetch", id, resp: { status: 200, body: '{"ok":true}' } });
  await jsonTask;
  assert.equal(json.ok, true);
  await h.complete();
  const next = await start(h);
  frame(h, next, 0, Buffer.from("new"));
  eof(h, next, 1, 3);
  await h.drain();
  assertSuccess(h, next, Buffer.from("new"));
});

test("disk failure rejects immediately before EOF, never starts queued writes", async () => {
  const h = harness();
  const t = await start(h);
  frame(h, t, 0, Buffer.alloc(CHUNK, 1));
  frame(h, t, 1, Buffer.alloc(CHUNK, 2));
  await h.complete(300);
  await h.complete(300); // preserved dual-type compatibility attempt
  assert.equal(t.events[0].kind, "fail");
  assert.equal(h.hooks.client.requests.size, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.files.size, 0);
  assert.ok(h.sent.some((message) => message.tag === "fetch-stream-cancel"));
});

for (const reason of ["disconnect", "plugin-error", "cancel", "ack-failure"]) {
  test(`${reason}: queued buffers are released and late completion cannot continue`, async () => {
    const h = harness();
    const t = await start(h);
    frame(h, t, 0, Buffer.alloc(CHUNK, 1));
    frame(h, t, 1, Buffer.alloc(CHUNK, 2));
    if (reason === "disconnect") h.hooks.client.conn.onclose();
    if (reason === "plugin-error")
      h.message({ tag: "fetch-stream-error", id: t.id, message: "HTTP failed" });
    if (reason === "cancel") t.task.cancel();
    if (reason === "ack-failure") {
      h.onSend = (message, options) => {
        if (message.tag === "fetch-stream-ack") options.fail("link failed");
      };
      frame(h, t, 0, Buffer.alloc(CHUNK, 1));
    }
    await tick();
    assert.equal(t.events[0].kind, "fail");
    await h.complete();
    assert.equal(h.calls.length, 1);
    assert.equal(h.files.size, 0);
  });
}

test("cache successful ArrayBuffer type across writes and downloads", async () => {
  const h = harness("array");
  const t = await start(h);
  for (let seq = 0; seq < 4; seq++) frame(h, t, seq, Buffer.alloc(CHUNK, seq));
  await h.complete();
  eof(h, t, 4, CHUNK * 4);
  await h.drain();
  assertSuccess(
    h,
    t,
    Buffer.concat(Array.from({ length: 4 }, (_, seq) => Buffer.alloc(CHUNK, seq)))
  );
  assert.equal(h.calls.filter((call) => !call.arrayBuffer).length, 1);
  const next = await start(h);
  frame(h, next, 0, Buffer.from("next"));
  eof(h, next, 1, 4);
  await h.drain();
  assertSuccess(h, next, Buffer.from("next"));
  assert.equal(h.calls.filter((call) => !call.arrayBuffer).length, 1);
});

test("final size/offset validation happens before the final ACK", async () => {
  for (const malformed of ["size", "overlap", "gap", "huge", "sequence", "chunk-size"]) {
    const h = harness();
    const t = await start(h);
    if (malformed === "size") {
      frame(h, t, 0, Buffer.from("abc"));
      eof(h, t, 1, 4);
    }
    if (malformed === "overlap") {
      frame(h, t, 1, Buffer.from("abc"), { offset: 2 });
      frame(h, t, 0, Buffer.from("abc"));
    }
    if (malformed === "gap") {
      frame(h, t, 1, Buffer.from("abc"), { offset: 4 });
      frame(h, t, 0, Buffer.from("abc"));
      eof(h, t, 2, 7);
    }
    if (malformed === "huge") frame(h, t, 1, Buffer.from("abc"), { offset: 1000000 });
    if (malformed === "sequence") frame(h, t, -1, Buffer.from("abc"));
    if (malformed === "chunk-size") frame(h, t, 0, Buffer.alloc(CHUNK + 1));
    await h.drain();
    assert.equal(t.events[0].kind, "fail", malformed);
    assert.equal(h.files.size, 0, malformed);
    if (malformed === "size") assert.ok(ack(h, t) < 2);
  }
});

test("v2 unpaced overflow fails with bounded buffers rather than growing a write chain", async () => {
  const h = harness();
  const t = await start(h, 3, { ack: false, chunkCount: 20 });
  for (let seq = 0; seq < 20; seq++) frame(h, t, seq, Buffer.alloc(CHUNK));
  await tick();
  assert.equal(t.events[0].kind, "fail");
  assert.equal(h.calls.length, 1);
  await h.complete();
  assert.equal(h.files.size, 0);
});

test("empty stream/chunked file and v1 single-message file still produce local URIs", async () => {
  for (const mode of ["stream", "chunked", "single"]) {
    const h = harness();
    const events = [];
    const task = h.api.fetch({
      url: "legacy",
      responseType: "file",
      success: (response) => events.push(response),
    });
    await tick();
    const id = h.sent.find((message) => message.tag === "fetch").id;
    const data = mode === "single" ? Buffer.from("legacy body") : Buffer.alloc(0);
    h.message({
      tag: "fetch",
      id,
      resp: {
        raw: true,
        ack: true,
        bodyEncoding: "base64",
        status: 200,
        ...(mode === "stream"
          ? { stream: true }
          : mode === "chunked"
            ? { chunked: true, chunkCount: 0 }
            : { body: data.toString("base64") }),
      },
    });
    if (mode === "stream")
      h.message({ tag: "fetch-stream", id, seq: 0, final: true, totalBytes: 0 });
    await h.drain();
    await task;
    assert.equal(events.length, 1, mode);
    assert.deepEqual(h.files.get(events[0].data), data, mode);
  }
});

test("non-file chunked JSON still assembles out-of-order and ignores duplicates", async () => {
  const h = harness();
  let result;
  const task = h.api.fetch({
    url: "json",
    responseType: "json",
    success: (response) => {
      result = response.data;
    },
  });
  await tick();
  const id = h.sent.find((message) => message.tag === "fetch").id;
  h.message({
    tag: "fetch",
    id,
    resp: { chunked: true, chunkCount: 2, ack: true, bodyEncoding: "text" },
  });
  for (const seq of [1, 1, 0])
    h.message({ tag: "fetch-chunk", id, seq, data: seq === 0 ? '{"ok":' : "true}" });
  await task;
  assert.equal(result.ok, true);
  assert.equal(h.calls.length, 0);
});

test("waiting task cancellation removes the request without disturbing the active download", async () => {
  const h = harness();
  const active = await start(h);
  frame(h, active, 0, Buffer.from("active"));
  let callback = false;
  const waiting = h.api.fetch({
    url: "cancel-before-start",
    responseType: "file",
    complete: () => {
      callback = true;
    },
  });
  waiting.cancel();
  waiting.cancel();
  await waiting;
  eof(h, active, 1, 6);
  await h.drain();
  assertSuccess(h, active, Buffer.from("active"));
  assert.equal(callback, false);
  assert.equal(h.sent.filter((message) => message.tag === "fetch").length, 1);
});

test("v1 native write timeout/cancel is bounded after the response leaves the request map", async () => {
  for (const mode of ["timeout", "cancel"]) {
    const h = harness();
    let failure;
    const task = h.api.fetch({
      url: "single",
      responseType: "file",
      fail: (message) => {
        failure = message;
      },
    });
    await tick();
    const id = h.sent.find((message) => message.tag === "fetch").id;
    h.message({ tag: "fetch", id, resp: { raw: true, bodyEncoding: "base64", body: "YWJj" } });
    await tick();
    assert.equal(h.hooks.client.requests.size, 0);
    assert.equal(h.pending.length, 1);
    if (mode === "timeout") await h.advance(20000);
    else task.cancel();
    await task;
    assert.match(failure, /timeout|cancelled/);
    await h.complete();
    assert.equal(h.files.size, 0);
  }
});

test("synchronous transport failure cleans up the registered request immediately", async () => {
  const h = harness();
  h.onSend = (message) => {
    if (message.tag === "fetch") throw new Error("send threw");
  };
  let failure;
  await h.api.fetch({
    url: "throw",
    responseType: "file",
    fail: (message) => {
      failure = message;
    },
  });
  assert.match(failure, /send threw/);
  assert.equal(h.hooks.client.requests.size, 0);
  assert.equal(h.calls.length, 0);
});

test("transport failure without an error payload still invokes fail and releases the request", async () => {
  const h = harness();
  h.onSend = (message, options) => {
    if (message.tag === "fetch") options.fail();
  };
  let failure;
  await h.api.fetch({
    url: "empty-error",
    responseType: "file",
    fail: (message) => {
      failure = message;
    },
  });
  assert.equal(failure, "interconnect request failed");
  assert.equal(h.hooks.client.requests.size, 0);
});

test("all 24 arrival permutations preserve short-tail bytes in v3 and v4", async () => {
  function permutations(values) {
    if (!values.length) return [[]];
    return values.flatMap((value, index) =>
      permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest])
    );
  }
  const pieces = [
    Buffer.alloc(CHUNK, 1),
    Buffer.alloc(CHUNK, 2),
    Buffer.alloc(CHUNK, 3),
    Buffer.from("tail"),
  ];
  const expected = Buffer.concat(pieces);
  for (const version of [3, 4]) {
    for (const order of permutations([0, 1, 2, 3])) {
      const h = harness();
      const t = await start(h, version, version === 3 ? { totalBytes: expected.length } : {});
      const writer = h.hooks.client.requests.get(t.id).sink;
      for (const seq of order) frame(h, t, seq, pieces[seq]);
      await h.drain();
      if (version === 4) eof(h, t, 4, expected.length);
      await tick();
      assertSuccess(h, t, expected);
      assert.ok(writer.stats.peakBytes <= 256 * 1024);
    }
  }
});

for (const version of [3, 4]) {
  test(`v${version}: 1MiB windowed sender progresses only on written ACKs`, async () => {
    const h = harness();
    const expected = Buffer.alloc(CHUNK * 32);
    for (let i = 0; i < expected.length; i++) expected[i] = (i * 17 + Math.floor(i / CHUNK)) & 255;
    const t = await start(
      h,
      version,
      version === 3 ? { chunkCount: 32, totalBytes: expected.length } : {}
    );
    const writer = h.hooks.client.requests.get(t.id).sink;
    const count = version === 4 ? 33 : 32;
    let base = 0,
      next = 0,
      retxBase = -1;
    function pump() {
      while (next < Math.min(base + 4, count)) {
        const seq = next++;
        if (seq === 32) eof(h, t, seq, expected.length);
        else frame(h, t, seq, expected.subarray(seq * CHUNK, (seq + 1) * CHUNK));
      }
    }
    h.onSend = (message) => {
      if (!/ack$/.test(message.tag)) return;
      if (message.ack > base) {
        base = message.ack;
        pump();
      } else if (message.ack === base && next > base && retxBase !== base) {
        retxBase = base;
        next = base;
        pump();
      }
    };
    pump();
    assert.equal(next, 4);
    assert.equal(base, 0);
    await h.drain();
    assertSuccess(h, t, expected);
    assert.equal(base, count);
    assert.ok(h.calls.length < 32);
    assert.ok(writer.stats.peakBytes <= 256 * 1024);
    console.log(
      `v${version} 1MiB: ${h.calls.length} physical writes, managed peak ${writer.stats.peakBytes} bytes`
    );
  });
}

test("window sender recovers a missing first frame, bad CRC and a lost advancing ACK", async () => {
  for (const fault of ["missing", "crc", "ack"]) {
    const h = harness();
    const t = await start(h);
    const pieces = Array.from({ length: 12 }, (_, seq) => Buffer.alloc(CHUNK, seq + 1));
    let base = 0,
      next = 0,
      retxBase = -1,
      injected = false;
    const pump = () => {
      while (next < Math.min(base + 4, 13)) {
        const seq = next++;
        if (seq === 12) {
          eof(h, t, seq, CHUNK * 12);
          continue;
        }
        if (!injected && fault === "missing" && seq === 0) {
          injected = true;
          continue;
        }
        if (!injected && fault === "crc" && seq === 1) {
          injected = true;
          frame(h, t, seq, pieces[seq], { crc32: "00000000" });
        } else frame(h, t, seq, pieces[seq]);
      }
    };
    h.onSend = (message) => {
      if (message.tag !== "fetch-stream-ack") return;
      if (!injected && fault === "ack" && message.ack > 0) {
        injected = true;
        return;
      }
      if (message.ack > base) {
        base = message.ack;
        pump();
      } else if (message.ack === base && next > base && retxBase !== base) {
        retxBase = base;
        next = base;
        pump();
      }
    };
    pump();
    await h.drain();
    assertSuccess(h, t, Buffer.concat(pieces));
    assert.equal(base, 13);
  }
});
