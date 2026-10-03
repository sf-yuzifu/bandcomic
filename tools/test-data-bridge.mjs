// Real sender/dataBridge/base64 code with delayed file callbacks and a protocol receiver.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const modules = ["base64.js", "stopWaitQueue.js", "windowedSender.js", "httpDataSync.js", "dataBridge.js"].map(
  (name) => fs.readFileSync(new URL("../src/components/" + name, import.meta.url), "utf8")
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const CHUNK = 6144;

function harness() {
  const h = {
    books: [], files: new Map(), sources: [], io: [], sent: [], toasts: [],
    readCalls: 0, getCalls: 0, peakFrames: 0, peakChars: 0,
    maps: [], afterSend: null, readFault: null, readComics: null, readSources: null,
    onLegacy: null, native: false, httpFetch: null,
  };
  const timers = new Map();
  let now = 0, timerId = 0;
  class FrameMap extends Map {
    set(key, value) {
      super.set(key, value);
      if (value && value.type) {
        if (!h.maps.includes(this)) h.maps.push(this);
        h.peakFrames = Math.max(h.peakFrames, this.size);
        h.peakChars = Math.max(h.peakChars, [...this.values()].reduce(
          (sum, frame) => sum + (frame.type === "cover_data_chunk" ? frame.data.length : 0), 0
        ));
      }
      return this;
    }
  }
  const file = {
    get(options) { h.getCalls++; h.io.push({ method: "get", options }); },
    readArrayBuffer(options) { h.readCalls++; h.io.push({ method: "read", options }); },
    mkdir(options) { h.io.push({ method: "mkdir", options }); },
    writeArrayBuffer(options) { h.io.push({ method: "write", options }); },
    access(options) { h.io.push({ method: "access", options }); },
    rmdir(options) { h.io.push({ method: "rmdir", options }); },
  };
  const sandbox = {
    prompt: { showToast: (options) => h.toasts.push(options.message) }, file,
    readComics: () => h.readComics ? h.readComics() : Promise.resolve(h.books),
    readSources: () => h.readSources ? h.readSources() : Promise.resolve(h.sources),
    safeJsonParse: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } },
    updateJsonFile: (uri, fallback, fn) => {
      if (uri === "history.json" || uri.endsWith("history.json")) {
        h.history = fn(JSON.parse(JSON.stringify(h.history || [])));
        return Promise.resolve(h.history);
      }
      h.books = fn(JSON.parse(JSON.stringify(h.books)));
      return Promise.resolve(h.books);
    },
    COMICS_URI: "comics.json",
    HISTORY_URI: "history.json",
    isAlreadyExistsError: (code) => code === 202,
    isNativeFetchSupported: () => h.native,
    gatewayFetch: (params) => h.httpFetch(params),
    global: { APP_SETTING: {} }, Uint8Array, Int8Array, ArrayBuffer, Promise, Map: FrameMap,
    console: { debug: () => {} },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const context = vm.createContext(sandbox);
  for (const source of modules) {
    vm.runInContext(source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);
  }
  h.bridge = context.createDataBridge({
    send(options) {
      // Serialize as QAIC does; do not rely on sender object lifetime for the receiver.
      const frame = JSON.parse(JSON.stringify(options.data));
      h.sent.push({ ...frame, readsBeforeSend: h.readCalls });
      if (options.success) options.success();
      if (frame.gseq !== undefined && h.afterSend) h.afterSend(frame);
      else if (h.onLegacy) h.onLegacy(frame);
    },
  });
  h.sender = context.createWindowedSender;
  h.message = (frame) => h.bridge.handleMessage({ data: JSON.stringify(frame) });
  h.handshake = (caps = { syncWindow: 4, syncSession: true }) =>
    h.message({ type: "hs_ping", session: "handshake", caps });
   h.request = (session = "current", http) => h.message({ type: "request_data", session, http });
  h.ack = (ack, session = "current") => h.message({ type: "sync_ack", ack, session });
  h.advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await tick();
    }
    now = target;
    await tick();
  };
  h.completeIO = async (fault) => {
    assert.ok(h.io.length);
    const { method, options } = h.io.shift();
    const bytes = h.files.get(options.uri);
    const problem = fault || (h.readFault && h.readFault(method, options));
    if (problem === "fail" || (options.uri && options.uri.endsWith("/cover") && method === "get" && !bytes)) {
      options.fail("missing", 301);
    } else if (method === "get") {
      options.success(options.recursive ? { subFiles: [] } : { length: bytes.length });
    } else if (method === "mkdir") {
      options.success();
    } else if (method === "write") {
      if (h.writeFault && h.writeFault(options)) {
        options.fail("disk error", 300);
      } else {
        const buf = options.buffer instanceof ArrayBuffer ? new Uint8Array(options.buffer) : options.buffer;
        h.files.set(options.uri, Buffer.from(buf));
        options.success();
      }
    } else if (method === "access") {
      if (h.accessFault && h.accessFault(options)) {
        options.fail("I/O error", 300);
      } else {
        options.success();
      }
    } else if (method === "rmdir") {
      if (h.rmdirFault && h.rmdirFault(options)) {
        options.fail("I/O error", 300);
      } else {
        const prefix = options.uri.endsWith("/") ? options.uri : options.uri + "/";
        for (const key of [...h.files.keys()]) {
          if (key === options.uri || key.startsWith(prefix)) {
            h.files.delete(key);
          }
        }
        options.success();
      }
    } else {
      const length = problem === "short" ? options.length - 1 : options.length;
      options.success({ buffer: Uint8Array.from(bytes.subarray(options.position, options.position + length)).buffer });
    }
    await tick();
  };
  h.drainIO = async () => {
    for (let n = 0; n < 10000; n++) {
      await tick();
      if (!h.io.length) return;
      await h.completeIO();
    }
    throw new Error("I/O did not drain");
  };
  h.load = (count, length = 10240, prefix = "Book") => {
    h.books = Array.from({ length: count }, (_, i) => {
      const book = { id: prefix + i, name: prefix + " " + i, chapters: [{ num: 0, page_count: 1, downloaded: 1 }] };
      const data = Buffer.alloc(length, i % 251);
      if (length >= 8) Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).copy(data);
      h.files.set("internal://files/" + book.id + "/cover", data);
      return book;
    });
  };
  return h;
}

function receiver(h, session = "current") {
  const r = { next: 0, buffered: new Map(), messages: [], pieces: new Map(), covers: new Map(), done: false, incomplete: 0, sendAck: true };
  r.accept = (frame) => {
    if (session !== null && frame.session !== session) return;
    if (frame.gseq >= r.next && !r.buffered.has(frame.gseq)) r.buffered.set(frame.gseq, frame);
    while (r.buffered.has(r.next)) {
      const msg = r.buffered.get(r.next++);
      r.buffered.delete(msg.gseq);
      r.messages.push(msg);
      if (msg.type === "cover_data_chunk") {
        const pieces = r.pieces.get(msg.name) || new Array(msg.total);
        pieces[msg.index] = msg.data;
        r.pieces.set(msg.name, pieces);
        if (pieces.filter(Boolean).length === msg.total) {
          const uri = pieces.join("");
          r.covers.set(msg.name, Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
          r.pieces.delete(msg.name);
        }
      }
      if (msg.type === "cover_done") {
        r.incomplete = r.pieces.size;
        r.pieces.clear();
        r.done = true;
      }
    }
    if (r.sendAck) h.ack(r.next, session);
  };
  h.afterSend = r.accept;
  return r;
}

const httpConfig = { protocol: 1, endpoints: ["http://127.0.0.1:51963"], instanceId: "host" };

test("dataBridge negotiates HTTP and sends metadata IDs plus binary covers without QAIC data frames", async () => {
  const h = harness();
  h.native = true;
  h.load(2, 20000);
  h.books.forEach((book) => { book.name = "同名漫画"; });
  const requests = [];
  h.httpFetch = async (params) => {
    requests.push(params);
    return { statusCode: 200, data: params.url.endsWith("/control/health")
      ? { service: "bandcomic-local-http", instanceId: "host", capabilities: { httpDataSync: 1 } } : { ok: true } };
  };
  h.handshake({ syncWindow: 4, syncSession: true, httpDataSync: 1 });
  assert.equal(h.sent[0].caps.httpDataSync, 1);
  h.request("current", httpConfig);
  await h.drainIO();
  assert.ok(requests.at(-1).url.endsWith("/complete"));
  assert.ok(!h.sent.some((f) => f.type === "cover_data_chunk" || f.type === "app_data_comic"));
  for (let index = 0; index < 2; index++) {
    const chunks = requests.filter((p) => p.url.includes("/covers/" + index + "?"));
    assert.deepEqual(Buffer.concat(chunks.map((p) => Buffer.from(p.data))), h.files.get("internal://files/Book" + index + "/cover"));
  }
});

test("dataBridge falls back before data when the native binary preflight fails", async () => {
  const h = harness();
  h.native = true;
  h.load(2);
  h.httpFetch = async () => { throw new Error("native POST unsupported"); };
  h.handshake({ syncWindow: 4, syncSession: true, httpDataSync: 1 });
  const r = receiver(h);
  h.request("current", httpConfig);
  await h.drainIO();
  assert.equal(r.done, true);
  assert.equal(r.covers.size, 2);
  assert.ok(h.sent.some((f) => f.type === "data_sync_transport" && f.session === "current"));
});

test("HTTP config cannot force a non-native device onto the HTTP data channel", async () => {
  const h = harness();
  h.load(1);
  h.httpFetch = () => { throw new Error("must not use HTTP"); };
  h.handshake({ syncWindow: 4, syncSession: true, httpDataSync: 1 });
  const r = receiver(h);
  h.request("current", httpConfig);
  await h.drainIO();
  assert.equal(h.sent[0].caps.httpDataSync, 0);
  assert.equal(r.done, true);
});

test("list starts before cover reads; 200 covers keep at most eight frames while ACKs stop", async () => {
  const h = harness();
  h.load(200);
  h.handshake();
  const r = receiver(h);
  h.afterSend = (frame) => {
    if (frame.type === "cover_data_chunk") r.sendAck = false;
    r.accept(frame);
  };
  h.request();
  await h.drainIO();
  const header = h.sent.find((frame) => frame.type === "app_data_header");
  assert.equal(header.readsBeforeSend, 0);
  assert.ok(r.messages.some((msg) => msg.type === "app_data_done"));
  assert.equal(h.peakFrames, 8);
  assert.equal(h.readCalls, 8);
  assert.equal(h.peakChars, 54712); // 四张10KiB PNG：每张13656字符+22字符data URI头
  assert.ok(h.peakChars <= 8 * (8192 + 23));
  const reads = h.readCalls;
  await h.advance(1000);
  assert.equal(h.readCalls, reads, "full cache cannot pre-read the rest of the library");
  r.sendAck = true;
  h.afterSend = r.accept;
  h.ack(r.next);
  await h.drainIO();
  assert.equal(r.covers.size, 200);
  assert.equal(r.done, true);
  for (const book of h.books) assert.deepEqual(r.covers.get(book.name), h.files.get("internal://files/" + book.id + "/cover"));
  assert.ok(h.maps.every((map) => map.size === 0));
  assert.equal(h.toasts.filter((message) => message === "数据发送完成").length, 1);
  console.log(`200 covers: sender peak ${h.peakChars} base64 characters / ${h.peakFrames} frames; old eager PNG fixture 2735600 characters`);
});

test("one large cover is read incrementally, independent of its total size", async () => {
  const h = harness();
  h.load(1, 512 * 1024);
  h.handshake();
  const r = receiver(h);
  h.afterSend = (frame) => { if (frame.type === "cover_data_chunk") r.sendAck = false; r.accept(frame); };
  h.request();
  await h.drainIO();
  assert.equal(h.readCalls, 8);
  assert.equal(h.peakFrames, 8);
  assert.ok(h.peakChars <= 65720);
  r.sendAck = true;
  h.afterSend = r.accept;
  h.ack(r.next);
  await h.drainIO();
  assert.deepEqual(r.covers.get(h.books[0].name), h.files.values().next().value);
  assert.equal(r.done, true);
});

for (const fault of ["missing", "out-of-order", "lost-ack", "send-failure"]) {
  test(`retransmission preserves gseq/payload and recovers ${fault}`, async () => {
    const h = harness();
    h.load(6);
    h.handshake();
    const r = receiver(h);
    let injected = false, held;
    h.afterSend = (frame) => {
      if (!injected && frame.type === "cover_data_chunk") {
        injected = true;
        if (fault === "missing" || fault === "send-failure") return;
        if (fault === "out-of-order") { held = frame; return; }
        if (fault === "lost-ack") { r.sendAck = false; r.accept(frame); r.sendAck = true; return; }
      }
      r.accept(frame);
      if (held) { const late = held; held = null; r.accept(late); }
    };
    h.request();
    await h.drainIO();
    if (!r.done) { await h.advance(3000); await h.drainIO(); }
    assert.equal(r.done, true);
    for (const book of h.books) assert.deepEqual(r.covers.get(book.name), h.files.get("internal://files/" + book.id + "/cover"));
    const bySeq = new Map();
    for (const frame of h.sent.filter((frame) => frame.gseq !== undefined)) {
      const signature = JSON.stringify({ type: frame.type, data: frame.data, name: frame.name, index: frame.index, total: frame.total });
      if (bySeq.has(frame.gseq)) assert.equal(bySeq.get(frame.gseq), signature);
      bySeq.set(frame.gseq, signature);
    }
    assert.ok(h.peakFrames <= 8);
  });
}

test("lost final ACK retransmits only retained frames and completes exactly once", async () => {
  const h = harness();
  h.load(1);
  h.handshake();
  const r = receiver(h);
  let dropped = false;
  h.afterSend = (frame) => {
    if (frame.type === "cover_done" && !dropped) {
      dropped = true;
      r.sendAck = false;
      r.accept(frame);
      r.sendAck = true;
    } else r.accept(frame);
  };
  h.request();
  await h.drainIO();
  assert.equal(h.toasts.includes("数据发送完成"), false);
  await h.advance(3000);
  assert.equal(h.toasts.filter((message) => message === "数据发送完成").length, 1);
  assert.equal(r.messages.filter((message) => message.type === "cover_done").length, 1);
  assert.ok(h.maps.every((map) => map.size === 0));
});

test("permanent ACK loss aborts with bounded cache and no further file reads", async () => {
  const h = harness();
  h.load(30);
  h.handshake();
  h.request();
  await h.drainIO();
  assert.equal(h.peakFrames, 8);
  assert.equal(h.readCalls, 0, "metadata stalls before any cover pre-read");
  await h.advance(18000);
  assert.equal(h.toasts.filter((message) => message === "发送中断，请重试").length, 1);
  assert.ok(h.maps.every((map) => map.size === 0));
  const count = h.sent.length;
  await h.advance(60000);
  assert.equal(h.sent.length, count);
});

test("reader stall has its own timeout even with no frames awaiting ACK", async () => {
  const h = harness();
  h.load(1);
  h.handshake();
  receiver(h);
  h.request();
  await tick();
  assert.equal(h.io.length, 1);
  await h.advance(20000);
  assert.ok(h.toasts.includes("发送中断，请重试"));
  assert.ok(h.maps.every((map) => map.size === 0));
  h.request("next");
  receiver(h, "next");
  await tick();
  assert.equal(h.io.length, 1, "cannot stack a new native read on the hung one");
  await h.completeIO();
  await tick();
  assert.equal(h.readCalls, 0, "late old metadata must not resume the cancelled producer");
});

for (const fault of ["fail", "short"]) {
  test(`cover ${fault} mid-read leaves no gseq hole and the next cover still arrives`, async () => {
    const h = harness();
    h.load(2, CHUNK * 5);
    h.handshake();
    const r = receiver(h);
    h.readFault = (method, params) => method === "read" && params.uri.includes("Book0/") && params.position === CHUNK * 2 ? fault : null;
    h.request();
    await h.drainIO();
    assert.equal(r.done, true);
    assert.equal(r.incomplete, 1);
    assert.equal(r.pieces.size, 0);
    assert.equal(r.covers.has(h.books[0].name), false);
    assert.deepEqual(r.covers.get(h.books[1].name), h.files.get("internal://files/Book1/cover"));
    assert.deepEqual(r.messages.map((msg) => msg.gseq), Array.from({ length: r.next }, (_, i) => i));
  });
}

test("missing and empty covers skip cleanly, empty library sends one completion", async () => {
  for (const count of [0, 3]) {
    const h = harness();
    h.load(count);
    h.files.clear();
    if (count) h.files.set("internal://files/Book1/cover", Buffer.alloc(0));
    h.handshake();
    const r = receiver(h);
    h.request();
    await h.drainIO();
    assert.equal(r.done, true);
    assert.equal(r.covers.size, 0);
    assert.equal(r.messages.filter((msg) => msg.type === "cover_done").length, 1);
  }
});

test("new handshake cancels in-flight reads and old callbacks cannot emit frames", async () => {
  const h = harness();
  h.load(1);
  h.handshake();
  receiver(h);
  h.request();
  await tick();
  await h.completeIO(); // file.get -> one pending read
  assert.equal(h.io[0].method, "read");
  h.handshake();
  const frames = h.sent.length;
  await h.completeIO();
  assert.equal(h.sent.length, frames);
  assert.ok(h.maps.every((map) => map.size === 0));
});

test("late readComics/readSources results cannot create an old sync sender", async () => {
  for (const delayed of ["readComics", "readSources"]) {
    const h = harness();
    h.load(1);
    h.handshake();
    let complete;
    h[delayed] = () => new Promise((resolve) => { complete = resolve; });
    h.request("old");
    await tick();
    h[delayed] = null;
    h.load(1, 100, "New");
    const r = receiver(h, "new");
    h.request("new");
    await h.drainIO();
    assert.equal(r.done, true);
    const count = h.sent.length;
    complete(delayed === "readComics" ? [{ id: "Old", name: "Old", chapters: [] }] : []);
    await tick();
    assert.equal(h.sent.length, count);
  }
});

test("old session ACKs do not confirm the new sender even when within its sent range", async () => {
  const h = harness();
  h.load(20);
  h.handshake();
  h.request("old");
  await tick();
  h.request("new");
  await tick();
  const count = h.sent.length;
  h.ack(4, "old");
  await tick();
  assert.equal(h.sent.length, count);
  h.ack(99999, "new");
  await tick();
  assert.equal(h.sent.length, count);
  const r = receiver(h, "new");
  for (const frame of h.sent.filter((msg) => msg.session === "new" && msg.gseq !== undefined).slice()) r.accept(frame);
  await h.drainIO();
  assert.equal(r.done, true);
});

test("old windowed plugin without session capability remains compatible", async () => {
  const h = harness();
  h.load(3);
  h.handshake({ syncWindow: 4 });
  const r = receiver(h, null);
  h.request(undefined);
  await h.drainIO();
  assert.equal(r.done, true);
  assert.ok(h.sent.filter((frame) => frame.gseq !== undefined).every((frame) => frame.session === undefined));
});

test("legacy stop-and-wait still sends covers and cancels an obsolete metadata flow", async () => {
  const h = harness();
  h.load(1, 100);
  h.handshake({});
  const pieces = [];
  h.onLegacy = (frame) => {
    let index;
    if (frame.type === "app_data_header") index = 0;
    if (frame.type === "app_data_comic") index = 1 + frame.index;
    if (frame.type === "app_data_done") index = 2;
    if (index !== undefined) queueMicrotask(() => h.message({ type: "app_data_ack", index }));
    if (frame.type === "cover_data_chunk") {
      pieces.push(frame.data);
      queueMicrotask(() => h.message({ type: "cover_ack", name: frame.name }));
    }
  };
  h.request();
  await tick();
  await h.advance(100);
  await h.drainIO();
  await h.advance(30); // 原有封面条间pacing完成后才调用onAllDone
  assert.ok(h.sent.some((msg) => msg.type === "cover_done"));
  assert.equal(pieces.length, 1);
  h.onLegacy = null;
  h.request();
  await tick();
  h.handshake({});
  const count = h.sent.length;
  await h.advance(60000);
  assert.equal(h.sent.length, count);
});

test("finite sender compatibility, empty source, bounded prefetch and slow production", async () => {
  const h = harness();
  let complete = 0;
  const empty = h.sender({ frames: [], sendFrame: () => assert.fail(), onAllDone: () => complete++ });
  await tick();
  assert.equal(empty.isFinished(), true);
  assert.equal(complete, 1);
  let supply;
  const sent = [];
  const sender = h.sender({
    readFrame: () => new Promise((resolve) => { supply = resolve; }),
    sendFrame: (frame) => sent.push(frame),
    ackTimeout: 3000, readTimeout: 20000,
  });
  await tick();
  await h.advance(5000);
  assert.equal(sender.isFinished(), false, "waiting for a producer is not ACK loss");
  supply({ type: "test" });
  await tick();
  assert.equal(sent.length, 1);
  sender.notifyAck(100);
  assert.equal(sender.isFinished(), false);
  sender.notifyAck(1);
  supply(null);
  await tick();
  assert.equal(sender.isFinished(), true);
});

test("import: late mkdir callback from cancelled import cannot mark new import ready", async () => {
  const h = harness();
  // 先发一个旧导入 Old，但不让 mkdir 立即完成
  h.message({ type: "import_comic_header", name: "Old", files: ["cover", "1"] });
  const oldMkdir = h.io.find((op) => op.method === "mkdir");
  assert.ok(oldMkdir);
  h.io.length = 0; // 清空队列表以便准确追踪

  // 发起新导入 New
  h.message({ type: "import_comic_header", name: "New", files: ["cover", "1"] });
  const newMkdir = h.io.find((op) => op.method === "mkdir");
  assert.ok(newMkdir);

  // New 发送一个分片，此时 New 的目录尚未 ready，应处于 pendingWrites
  h.message({ type: "import_comic_chunk", name: "New", file: "1", index: 0, total: 1, data: "YWJj" });
  assert.ok(!h.io.some((op) => op.method === "write"));

  // 此时旧导入的 mkdir 迟到回调执行
  oldMkdir.options.success();
  await tick();

  // 校验：旧 mkdir 不能导致 New 目录提前就绪，因此不能触发任何文件写入
  assert.ok(!h.io.some((op) => op.method === "write"), "旧 mkdir 不能推进新会话的写操作");

  // New 自身的 mkdir 真正成功
  newMkdir.options.success();
  await tick();

  // New 的待写队列才被冲刷并启动写盘
  assert.ok(h.io.some((op) => op.method === "write"), "新 mkdir 成功后待写队列正常冲刷");
});

test("import: old chunks and old done are discarded and cannot contaminate new session", async () => {
  const h = harness();
  // 建立导入 Old
  h.message({ type: "import_comic_header", name: "Old", files: ["cover", "1"] });
  await h.drainIO();

  // 切换为导入 New
  h.message({ type: "import_comic_header", name: "New", files: ["cover", "1"] });
  await h.drainIO();

  // 来自 Old 的分片到达
  h.message({
    type: "import_comic_chunk",
    name: "Old",
    file: "1",
    index: 0,
    total: 1,
    data: Buffer.from("OLD_DATA").toString("base64"),
  });
  await tick();

  // 来自 Old 的 done 到达
  h.message({ type: "import_comic_done", name: "Old" });
  await tick();

  // 校验：不能生成任何属于 Old 的写入
  const filesArray = [...h.files.keys()];
  assert.equal(filesArray.length, 0, "旧分片已被丢弃，没有文件落盘");
  assert.equal(h.books.length, 0, "旧 done 被丢弃，未把新导入提前登记为完成");

  // 正常传入 New 的分片与 done
  h.message({
    type: "import_comic_chunk",
    name: "New",
    file: "1",
    index: 0,
    total: 1,
    data: Buffer.from("NEW_DATA").toString("base64"),
  });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "New" });
  await h.drainIO();

  assert.equal(h.books.length, 1);
  assert.equal(h.books[0].name, "New");
  const written = [...h.files.values()][0];
  assert.equal(written.toString(), "NEW_DATA");
});

test("import: handshake cancels in-flight import session and drops late chunks", async () => {
  const h = harness();
  h.message({ type: "import_comic_header", name: "Old", files: ["cover", "1"] });
  await h.drainIO();

  // 握手重入
  h.handshake();
  await tick();

  // 之后到达的 Old 分片与 done 应被丢弃
  h.message({ type: "import_comic_chunk", name: "Old", file: "1", index: 0, total: 1, data: "YWJj" });
  h.message({ type: "import_comic_done", name: "Old" });
  await tick();

  assert.equal(h.files.size, 0);
  assert.equal(h.books.length, 0);
});

test("import: same name consecutive import isolates sessions and drops old session chunks", async () => {
  const h = harness();
  // 第一次导入同名漫画，带 sessionId: "session_1"
  h.message({
    type: "import_comic_header",
    name: "SameComic",
    sessionId: "session_1",
    files: ["cover", "1"],
  });
  const firstMkdir = h.io.find((op) => op.method === "mkdir");
  assert.ok(firstMkdir);
  h.io.length = 0;

  // 第二次导入同名漫画，带 sessionId: "session_2"
  h.message({
    type: "import_comic_header",
    name: "SameComic",
    sessionId: "session_2",
    files: ["cover", "1"],
  });
  const secondMkdir = h.io.find((op) => op.method === "mkdir");
  assert.ok(secondMkdir);

  // session_2 到达分片，处于待写队列
  h.message({
    type: "import_comic_chunk",
    name: "SameComic",
    sessionId: "session_2",
    file: "1",
    index: 0,
    total: 1,
    data: Buffer.from("SESSION_2").toString("base64"),
  });
  assert.ok(!h.io.some((op) => op.method === "write"));

  // 迟到的 session_1 mkdir 回调触发
  firstMkdir.options.success();
  await tick();
  assert.ok(!h.io.some((op) => op.method === "write"), "旧会话的 mkdir 不能提前冲刷新会话");

  // 迟到的 session_1 分片与 done 到达
  h.message({
    type: "import_comic_chunk",
    name: "SameComic",
    sessionId: "session_1",
    file: "1",
    index: 0,
    total: 1,
    data: Buffer.from("SESSION_1").toString("base64"),
  });
  h.message({
    type: "import_comic_done",
    name: "SameComic",
    sessionId: "session_1",
  });
  await tick();
  assert.equal(h.books.length, 0, "旧会话 done 不能完成新会话");

  // session_2 mkdir 成功
  secondMkdir.options.success();
  await tick();
  await h.drainIO();

  // session_2 done
  h.message({
    type: "import_comic_done",
    name: "SameComic",
    sessionId: "session_2",
  });
  await h.drainIO();

  assert.equal(h.books.length, 1);
  const written = [...h.files.values()][0];
  assert.equal(written.toString(), "SESSION_2");
});

test("import: done with missing file chunks reports only saved files and excludes missing pages from downloaded", async () => {
  const h = harness();
  // 声明 3 个文件：封面 + 2 页正文
  h.message({ type: "import_comic_header", name: "MissingTest", files: ["cover", "1", "2"] });
  await h.drainIO();

  // cover 完整接收并落盘
  h.message({ type: "import_comic_chunk", name: "MissingTest", file: "cover", index: 0, total: 1, data: "YWJj" });
  await h.drainIO();

  // 正文 1 缺尾片（total=2 但只到了 index 0），正文 2 完全没到
  h.message({ type: "import_comic_chunk", name: "MissingTest", file: "1", index: 0, total: 2, data: "YWJj" });
  await tick();

  // 提前收到 done
  h.message({ type: "import_comic_done", name: "MissingTest" });
  await h.drainIO();

  // 校验：仅 cover 实际落盘
  assert.equal(h.files.size, 1);
  // 正文页 downloaded 应为 0，而不是误报的 2
  assert.equal(h.books[0].chapters[0].downloaded, 0);
  assert.equal(h.books[0].chapters[0].page_count, 2);
  // Toast 应明确指出仅完成 1/3，并提示 2 个失败
  assert.ok(h.toasts.some((s) => s.includes("(1/3文件，2个失败)")));
  assert.ok(!h.toasts.some((s) => s.includes("(3/3文件)")));
});

test("import: disk write failures accurately reduce downloaded count and report failed count in toast", async () => {
  const h = harness();
  h.writeFault = () => true; // 模拟写盘全部失败

  h.message({ type: "import_comic_header", name: "FailTest", files: ["cover", "1"] });
  await h.drainIO();

  h.message({ type: "import_comic_chunk", name: "FailTest", file: "cover", index: 0, total: 1, data: "YWJj" });
  h.message({ type: "import_comic_chunk", name: "FailTest", file: "1", index: 0, total: 1, data: "YWJj" });
  await h.drainIO();

  h.message({ type: "import_comic_done", name: "FailTest" });
  await h.drainIO();

  // 磁盘实际无文件
  assert.equal(h.files.size, 0);
  // 正文 downloaded 为 0，不被错误登记为 1
  assert.equal(h.books[0].chapters[0].downloaded, 0);
  assert.ok(h.toasts.some((s) => s.includes("(0/2文件，2个失败)")));
});

test("import: multi-chapter mode accurately tracks downloaded count per chapter and accounts for optional cover", async () => {
  const h = harness();
  // 模拟对指定文件写入失败：让第1章第2页失败
  h.writeFault = (options) => options.uri.includes("第1章/2");

  h.message({
    type: "import_comic_header",
    name: "MultiTest",
    mode: "multi",
    chapters: [
      { name: "第1章", files: ["1", "2"] },
      { name: "第2章", files: ["1"] },
    ],
  });
  await h.drainIO();

  // 发送多章模式可选封面
  h.message({ type: "import_comic_chunk", name: "MultiTest", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  // 第1章第1页 (成功)
  h.message({ type: "import_comic_chunk", name: "MultiTest", file: "第1章/1", index: 0, total: 1, data: "cGcx" });
  // 第1章第2页 (注入失败)
  h.message({ type: "import_comic_chunk", name: "MultiTest", file: "第1章/2", index: 0, total: 1, data: "cGcy" });
  // 第2章第1页 (成功)
  h.message({ type: "import_comic_chunk", name: "MultiTest", file: "第2章/1", index: 0, total: 1, data: "cGcz" });
  await h.drainIO();

  h.message({ type: "import_comic_done", name: "MultiTest" });
  await h.drainIO();

  assert.equal(h.books.length, 1);
  const book = h.books[0];
  assert.equal(book.chapters.length, 2);
  // 第1章：声明2页，实落1页
  assert.equal(book.chapters[0].page_count, 2);
  assert.equal(book.chapters[0].downloaded, 1);
  // 第2章：声明1页，实落1页
  assert.equal(book.chapters[1].page_count, 1);
  assert.equal(book.chapters[1].downloaded, 1);

  // 封面 + 2个正文页共3个文件在磁盘
  assert.equal(h.files.size, 3);
  // 提示：共3个章节文件，完成2个，1个失败
  assert.ok(h.toasts.some((s) => s.includes("(2/3文件，1个失败)")));
});

test("delete_comic: rmdir failure retains comic in index and reports error toast", async () => {
  const h = harness();
  h.message({ type: "import_comic_header", name: "KeepBook", files: ["cover", "1"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "KeepBook", file: "cover", index: 0, total: 1, data: "YWJj" });
  h.message({ type: "import_comic_chunk", name: "KeepBook", file: "1", index: 0, total: 1, data: "YWJj" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "KeepBook" });
  await h.drainIO();
  assert.equal(h.books.length, 1);

  // 注入 rmdir 失败（模拟 I/O 故障）
  h.rmdirFault = () => true;

  h.message({ type: "delete_comic", name: "KeepBook" });
  await h.drainIO();

  // 校验：索引不能被移除，应保留管理入口
  assert.equal(h.books.length, 1, "rmdir 失败时不应删除索引");
  assert.ok(h.toasts.some((s) => s.includes("删除失败，请重试")));
});

test("delete_comic: successful rmdir or missing directory removes index", async () => {
  const h = harness();
  h.message({ type: "import_comic_header", name: "DelBook", files: ["cover", "1"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "DelBook", file: "cover", index: 0, total: 1, data: "YWJj" });
  h.message({ type: "import_comic_chunk", name: "DelBook", file: "1", index: 0, total: 1, data: "YWJj" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "DelBook" });
  await h.drainIO();
  assert.equal(h.books.length, 1);

  h.message({ type: "delete_comic", name: "DelBook" });
  await h.drainIO();

  assert.equal(h.books.length, 0, "成功删除后索引应被移除");
  assert.ok(h.toasts.some((s) => s.includes("已删除: DelBook")));
});

test("cleanTempFiles: removes orphan comic directories and temp files while preserving registered ones", async () => {
  const storageSrc = fs.readFileSync(new URL("../src/components/storage.js", import.meta.url), "utf8");
  const filesOnDisk = new Map([
    ["internal://files/comics.json", Buffer.from(JSON.stringify([{ id: "valid_comic_1", name: "Valid" }]))],
    ["internal://files/settings.json", Buffer.from("{}")],
    ["internal://files/_icf_temp_1", Buffer.from("temp1")],
    ["internal://files/_icf_temp_2", Buffer.from("temp2")],
  ]);
  const dirsOnDisk = new Set([
    "internal://files/valid_comic_1",
    "internal://files/orphan_comic_old",
  ]);

  const fileMock = {
    readText(options) {
      const data = filesOnDisk.get(options.uri);
      if (data) options.success({ text: data.toString("utf8") });
      else options.fail("not found", 301);
    },
    list(options) {
      const fileList = [];
      for (const uri of filesOnDisk.keys()) {
        fileList.push({ uri, type: "file" });
      }
      for (const uri of dirsOnDisk) {
        fileList.push({ uri, type: "dir" });
      }
      options.success({ fileList });
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      options.success();
    },
    rmdir(options) {
      dirsOnDisk.delete(options.uri);
      options.success();
    },
  };

  const context = vm.createContext({
    file: fileMock,
    console: { debug: () => {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
  });

  vm.runInContext(storageSrc.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);

  const res = await context.cleanTempFiles();

  // 清理了 2 个 _icf_ 临时文件 + 1 个孤儿目录 = 共 3 项
  assert.equal(res.count, 3);
  // 孤儿目录被删除了
  assert.ok(!dirsOnDisk.has("internal://files/orphan_comic_old"));
  // 有效漫画目录依然保留
  assert.ok(dirsOnDisk.has("internal://files/valid_comic_1"));
  // 持久化文件依然保留
  assert.ok(filesOnDisk.has("internal://files/comics.json"));
  assert.ok(filesOnDisk.has("internal://files/settings.json"));
  // 临时文件被删除
  assert.ok(!filesOnDisk.has("internal://files/_icf_temp_1"));
  assert.ok(!filesOnDisk.has("internal://files/_icf_temp_2"));
});

test("cleanTempFiles: preserves in-flight protected temp files and advances clean sequence (P1-37)", async () => {
  const storageSrc = fs.readFileSync(new URL("../src/components/storage.js", import.meta.url), "utf8");
  const filesOnDisk = new Map([
    ["internal://files/comics.json", Buffer.from("[]")],
    ["internal://files/_icf_abandoned", Buffer.from("abandoned")],
    ["internal://files/_icf_writing_inflight", Buffer.from("inflight_data")],
  ]);

  const fileMock = {
    readText(options) {
      const data = filesOnDisk.get(options.uri);
      if (data) options.success({ text: data.toString("utf8") });
      else options.fail("not found", 301);
    },
    list(options) {
      const fileList = [];
      for (const uri of filesOnDisk.keys()) {
        fileList.push({ uri, type: "file" });
      }
      options.success({ fileList });
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      options.success();
    },
    rmdir(options) {
      options.success();
    },
  };

  const appGlobal = {};

  const context = vm.createContext({
    global: appGlobal,
    file: fileMock,
    console: { debug: () => {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
  });

  vm.runInContext(storageSrc.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);

  // 1. 注册受保护的在途临时文件
  const unprotect = context.protectTempFile("internal://files/_icf_writing_inflight");
  assert.equal(context.isTempFileProtected("internal://files/_icf_writing_inflight"), true);

  // 2. 执行清理
  const res = await context.cleanTempFiles();
  assert.equal(res.count, 1, "只清理了未受保护的废弃临时文件");
  assert.ok(!filesOnDisk.has("internal://files/_icf_abandoned"), "废弃文件已被清理");
  assert.ok(filesOnDisk.has("internal://files/_icf_writing_inflight"), "正在写入的在途文件受到严格保护未被误删");
  assert.equal(appGlobal.__tempFilesCleanSeq, 1, "清理版本序列号成功递增");

  // 3. 模拟写盘结束释放保护后，再次清理可被正常回收
  unprotect();
  assert.equal(context.isTempFileProtected("internal://files/_icf_writing_inflight"), false);
  const res2 = await context.cleanTempFiles();
  assert.equal(res2.count, 1);
  assert.ok(!filesOnDisk.has("internal://files/_icf_writing_inflight"));
  assert.equal(appGlobal.__tempFilesCleanSeq, 2);
});

test("writeJsonFileAtomic: retains original data when first move fails due to I/O error on non-existent or existing target", async () => {
  const storageSrc = fs.readFileSync(new URL("../src/components/storage.js", import.meta.url), "utf8");
  const filesOnDisk = new Map([
    ["internal://files/comics.json", Buffer.from(JSON.stringify([{ id: "book_orig", name: "Original Book" }]))],
  ]);

  let moveAttempts = 0;
  const fileMock = {
    readText(options) {
      const data = filesOnDisk.get(options.uri);
      if (data) options.success({ text: data.toString("utf8") });
      else options.fail("not found", 301);
    },
    writeText(options) {
      filesOnDisk.set(options.uri, Buffer.from(options.text));
      options.success();
    },
    access(options) {
      if (filesOnDisk.has(options.uri)) options.success();
      else options.fail("missing", 301);
    },
    move(options) {
      moveAttempts++;
      // 模拟固件 move 遇到已存在文件时失败（code 202）
      if (options.srcUri.endsWith(".tmp") && options.dstUri === "internal://files/comics.json" && moveAttempts === 1) {
        options.fail("already exists", 202);
        return;
      }
      // 其余 move 正常执行
      const data = filesOnDisk.get(options.srcUri);
      filesOnDisk.delete(options.srcUri);
      filesOnDisk.set(options.dstUri, data);
      options.success();
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      options.success();
    },
  };

  const context = vm.createContext({
    file: fileMock,
    console: { debug: () => {}, warn: () => {}, error: () => {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
  });

  vm.runInContext(storageSrc.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);

  // 执行原子写新数据
  const newData = [{ id: "book_new", name: "New Book" }];
  await context.writeJsonFile("internal://files/comics.json", newData);

  // 验证：新数据成功落盘为正式文件，.bak 已被清理
  const readBack = await context.readJsonFile("internal://files/comics.json", []);
  assert.equal(readBack[0].id, "book_new");
  assert.ok(!filesOnDisk.has("internal://files/comics.json.bak"));
});

test("writeJsonFileAtomic: rollback restores .bak to original file if second move fails", async () => {
  const storageSrc = fs.readFileSync(new URL("../src/components/storage.js", import.meta.url), "utf8");
  const filesOnDisk = new Map([
    ["internal://files/comics.json", Buffer.from(JSON.stringify([{ id: "book_precious", name: "Precious" }]))],
  ]);

  const fileMock = {
    readText(options) {
      const data = filesOnDisk.get(options.uri);
      if (data) options.success({ text: data.toString("utf8") });
      else options.fail("not found", 301);
    },
    writeText(options) {
      filesOnDisk.set(options.uri, Buffer.from(options.text));
      options.success();
    },
    access(options) {
      if (filesOnDisk.has(options.uri)) options.success();
      else options.fail("missing", 301);
    },
    move(options) {
      // 首次 move（.tmp -> comics.json）模拟目标存在失败
      if (options.srcUri.endsWith(".tmp") && options.dstUri === "internal://files/comics.json") {
        options.fail("move failed", 300);
        return;
      }
      // 允许 comics.json -> comics.json.bak 成功
      // 允许 rollback: comics.json.bak -> comics.json 成功
      const data = filesOnDisk.get(options.srcUri);
      filesOnDisk.delete(options.srcUri);
      filesOnDisk.set(options.dstUri, data);
      options.success();
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      options.success();
    },
  };

  const context = vm.createContext({
    file: fileMock,
    console: { debug: () => {}, warn: () => {}, error: () => {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
  });

  vm.runInContext(storageSrc.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);

  let writeError = null;
  try {
    await context.writeJsonFile("internal://files/comics.json", [{ id: "book_lost", name: "Lost" }]);
  } catch (err) {
    writeError = err;
  }

  // 必须抛出错误提示写入失败
  assert.ok(writeError);
  // 但旧文件经过 rollback 必须完好无损保留！
  const savedData = await context.readJsonFile("internal://files/comics.json", []);
  assert.equal(savedData[0].id, "book_precious", "二次move失败必须回滚恢复旧数据");
});

test("readJsonFile: automatically recovers from .bak or .tmp when main file is missing", async () => {
  const storageSrc = fs.readFileSync(new URL("../src/components/storage.js", import.meta.url), "utf8");
  // 主文件缺失，但留下了有效 .bak
  const filesOnDisk = new Map([
    ["internal://files/history.json.bak", Buffer.from(JSON.stringify([{ id: "recovered_hist", page: 10 }]))],
  ]);

  const fileMock = {
    readText(options) {
      const data = filesOnDisk.get(options.uri);
      if (data) options.success({ text: data.toString("utf8") });
      else options.fail("not found", 301);
    },
    access(options) {
      if (filesOnDisk.has(options.uri)) options.success();
      else options.fail("missing", 301);
    },
    move(options) {
      const data = filesOnDisk.get(options.srcUri);
      filesOnDisk.delete(options.srcUri);
      filesOnDisk.set(options.dstUri, data);
      options.success();
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      options.success();
    },
  };

  const context = vm.createContext({
    file: fileMock,
    console: { debug: () => {}, warn: () => {}, error: () => {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
  });

  vm.runInContext(storageSrc.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);

  const hist = await context.readHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].id, "recovered_hist");
  // 恢复后主文件存在，.bak 已被提升还原
  assert.ok(filesOnDisk.has("internal://files/history.json"));
});

test("import: duplicate import replaces local comic and removes old directory (P1-30)", async () => {
  const h = harness();
  // 首次导入
  h.message({ type: "import_comic_header", name: "DupeBook", files: ["cover", "1"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "DupeBook", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  h.message({ type: "import_comic_chunk", name: "DupeBook", file: "1", index: 0, total: 1, data: "cGFnZTE=" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "DupeBook" });
  await h.drainIO();

  assert.equal(h.books.length, 1);
  const oldId = h.books[0].id;
  assert.ok(oldId.startsWith("local_"));
  assert.ok(h.files.has("internal://files/" + oldId + "/1"));

  // 再次导入同名漫画
  h.message({ type: "import_comic_header", name: "DupeBook", files: ["cover", "1", "2"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "DupeBook", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  h.message({ type: "import_comic_chunk", name: "DupeBook", file: "1", index: 0, total: 1, data: "cGFnZTE=" });
  h.message({ type: "import_comic_chunk", name: "DupeBook", file: "2", index: 0, total: 1, data: "cGFnZTI=" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "DupeBook" });
  await h.drainIO();

  // 校验：索引依然只有 1 条，ID 已更新为新 ID
  assert.equal(h.books.length, 1);
  const newId = h.books[0].id;
  assert.notEqual(newId, oldId);
  assert.equal(h.books[0].page_count, 2);

  // 校验：旧目录已被递归清理，新目录文件存在
  assert.ok(!h.files.has("internal://files/" + oldId + "/1"), "旧导入目录应被安全清理");
  assert.ok(h.files.has("internal://files/" + newId + "/1"), "新导入目录文件应保留");
  assert.ok(h.files.has("internal://files/" + newId + "/2"), "新导入目录文件应保留");
});

test("import: same name as online comic preserves online comic and does not replace its id or directory (P1-30)", async () => {
  const h = harness();
  // 模拟预先存在一本同名的在线下载漫画
  const onlineId = "copymanga_12345";
  h.books = [{ id: onlineId, name: "CrossSourceBook", page_count: 5, is_serial: false }];
  h.files.set("internal://files/" + onlineId + "/1", Buffer.from("online_page"));

  // 导入一本同名漫画
  h.message({ type: "import_comic_header", name: "CrossSourceBook", files: ["cover", "1"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "CrossSourceBook", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  h.message({ type: "import_comic_chunk", name: "CrossSourceBook", file: "1", index: 0, total: 1, data: "cGFnZTE=" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "CrossSourceBook" });
  await h.drainIO();

  // 校验：在线漫画条目完好保留，未被篡改为 local_；新增独立的导入条目
  assert.equal(h.books.length, 2, "同名在线漫画不应被导入记录替换覆盖");
  const onlineBook = h.books.find((b) => b.id === onlineId);
  const localBook = h.books.find((b) => b.id !== onlineId);

  assert.ok(onlineBook, "在线条目必须存在");
  assert.equal(onlineBook.id, onlineId);
  assert.ok(localBook, "本地条目必须存在");
  assert.ok(localBook.id.startsWith("local_"));

  // 在线目录绝不能被误清理
  assert.ok(h.files.has("internal://files/" + onlineId + "/1"), "在线漫画目录文件不得被误删除");
});

test("import: duplicate import migrates reading history to new local id (P1-30)", async () => {
  const h = harness();
  // 首次导入
  h.message({ type: "import_comic_header", name: "HistBook", files: ["cover", "1"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "HistBook", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  h.message({ type: "import_comic_chunk", name: "HistBook", file: "1", index: 0, total: 1, data: "cGFnZTE=" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "HistBook" });
  await h.drainIO();

  const oldId = h.books[0].id;
  // 模拟用户阅读过该漫画，历史记录中包含进度
  h.history = [
    {
      id: "local_" + oldId,
      originalId: oldId,
      title: "HistBook",
      chapter: 1,
      page: 3,
      last_read_time: 123456,
    },
  ];

  // 再次导入该漫画
  h.message({ type: "import_comic_header", name: "HistBook", files: ["cover", "1", "2"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "HistBook", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  h.message({ type: "import_comic_chunk", name: "HistBook", file: "1", index: 0, total: 1, data: "cGFnZTE=" });
  h.message({ type: "import_comic_chunk", name: "HistBook", file: "2", index: 0, total: 1, data: "cGFnZTI=" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "HistBook" });
  await h.drainIO();

  const newId = h.books[0].id;
  assert.notEqual(newId, oldId);

  // 校验：阅读历史已平滑迁移至新 ID，续读进度保留
  assert.equal(h.history.length, 1);
  assert.equal(h.history[0].id, "local_" + newId);
  assert.equal(h.history[0].originalId, newId);
  assert.equal(h.history[0].page, 3);
});

test("import: failed/cancelled duplicate import does not corrupt old comic (P1-30)", async () => {
  const h = harness();
  // 首次导入成功
  h.message({ type: "import_comic_header", name: "SafeBook", files: ["cover", "1"] });
  await h.drainIO();
  h.message({ type: "import_comic_chunk", name: "SafeBook", file: "cover", index: 0, total: 1, data: "Y292ZXI=" });
  h.message({ type: "import_comic_chunk", name: "SafeBook", file: "1", index: 0, total: 1, data: "cGFnZTE=" });
  await h.drainIO();
  h.message({ type: "import_comic_done", name: "SafeBook" });
  await h.drainIO();

  const oldId = h.books[0].id;
  assert.ok(h.files.has("internal://files/" + oldId + "/1"));

  // 再次开始同名导入，但新会话中途断开/取消，未发送 done
  h.message({ type: "import_comic_header", name: "SafeBook", files: ["cover", "1", "2"] });
  await h.drainIO();
  // 模拟新导入被新的操作打断取消
  h.handshake();
  await h.drainIO();

  // 校验：旧漫画依然完好，索引依然指向旧 ID
  assert.equal(h.books.length, 1);
  assert.equal(h.books[0].id, oldId);
  assert.ok(h.files.has("internal://files/" + oldId + "/1"), "未成功的导入绝不能损坏旧漫画文件");
});


