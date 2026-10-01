// Real sender/dataBridge/base64 code with delayed file callbacks and a protocol receiver.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const modules = ["base64.js", "stopWaitQueue.js", "windowedSender.js", "dataBridge.js"].map(
  (name) => fs.readFileSync(new URL("../src/components/" + name, import.meta.url), "utf8")
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const CHUNK = 6144;

function harness() {
  const h = {
    books: [], files: new Map(), sources: [], io: [], sent: [], toasts: [],
    readCalls: 0, getCalls: 0, peakFrames: 0, peakChars: 0,
    maps: [], afterSend: null, readFault: null, readComics: null, readSources: null,
    onLegacy: null,
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
  };
  const sandbox = {
    prompt: { showToast: (options) => h.toasts.push(options.message) }, file,
    readComics: () => h.readComics ? h.readComics() : Promise.resolve(h.books),
    readSources: () => h.readSources ? h.readSources() : Promise.resolve(h.sources),
    safeJsonParse: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } },
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
  h.request = (session = "current") => h.message({ type: "request_data", session });
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
    if (problem === "fail" || (options.uri.endsWith("/cover") && !bytes)) {
      options.fail("missing", 301);
    } else if (method === "get") {
      options.success(options.recursive ? { subFiles: [] } : { length: bytes.length });
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
