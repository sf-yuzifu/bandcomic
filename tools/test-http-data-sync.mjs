import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function harness(options = {}) {
  const h = { sent: [], reads: [], files: new Map(), current: true, held: null };
  const sandbox = {
    ArrayBuffer, Uint8Array, Promise, setTimeout, clearTimeout,
    console: { warn() {} },
    require(name) {
      if (name === "@system.file") return {};
      if (name === "@system.fetch") return { fetch(params) {
        h.sent.push(params);
        if (options.fetch) return options.fetch(params, h);
        const data = params.url.endsWith("/control/health")
          ? { service: "bandcomic-local-http", instanceId: "host", capabilities: { httpDataSync: 1 } } : { ok: true };
        params.success({ code: 200, data: JSON.stringify(data) });
      } };
    },
  };
  const context = vm.createContext(sandbox);
  for (const name of ["jsonUtils.js", "httpResponse.js", "gatewayFetch.js", "httpDataSync.js"]) {
    const code = fs.readFileSync(new URL("../src/components/" + name, import.meta.url), "utf8");
    vm.runInContext(code.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""), context);
  }
  const request = { session: "sync1", http: { protocol: 1, endpoints: ["http://127.0.0.1:51963"], instanceId: "host" } };
  h.run = (comics, sources = []) => context.sendHttpData(request, comics, sources, comics, {
    isCurrent: () => h.current,
    async readFile(method, params) {
      h.reads.push({ method, ...params });
      const bytes = h.files.get(params.uri);
      if (!bytes) return null;
      if (method === "get") return { length: bytes.length };
      if (options.read) return options.read(params, bytes, h);
      // Deliberately return a view into a larger backing store.
      const backing = new Uint8Array(params.length + 12).fill(77);
      backing.set(bytes.subarray(params.position, params.position + params.length), 5);
      return { buffer: backing.subarray(5, 5 + params.length) };
    },
  });
  h.book = (id, length) => {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
    h.files.set("internal://files/" + id + "/cover", bytes);
    return { id, name: "同名漫画", page_count: 1, chapters: 0 };
  };
  return h;
}

test("real gatewayFetch sends binary probe and exact, bounded cover bytes without Base64", async () => {
  const h = harness();
  const books = [h.book("a", 40000), h.book("b", 200)];
  const result = await h.run(books);
  assert.equal(result.fallback, false);
  const probe = h.sent.find((p) => p.url.endsWith("/probe"));
  assert.ok(probe.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(probe.data)], [0, 1, 127, 128, 255, 0, 42, 13, 10]);
  for (let index = 0; index < books.length; index++) {
    const chunks = h.sent.filter((p) => p.url.includes("/covers/" + index + "?"));
    assert.ok(chunks.every((p) => p.data.byteLength <= 16384 && p.header["Content-Type"] === "application/octet-stream"));
    assert.deepEqual(Buffer.concat(chunks.map((p) => Buffer.from(p.data))),
      Buffer.from(h.files.get("internal://files/" + books[index].id + "/cover")));
  }
  assert.ok(h.sent.at(-1).url.endsWith("/complete"));
});

test("cover producer waits for native completion and does not pre-read the next binary block", async () => {
  const h = harness({ fetch(params, state) {
    if (params.url.includes("/covers/")) { state.held = params; return; }
    params.success({ code: 200, data: JSON.stringify(params.url.endsWith("/control/health")
      ? { service: "bandcomic-local-http", instanceId: "host", capabilities: { httpDataSync: 1 } } : { ok: true }) });
  } });
  const promise = h.run([h.book("a", 20000)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.filter((r) => r.method === "readArrayBuffer").length, 1);
  h.held.success({ code: 200, data: '{"ok":true}' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.filter((r) => r.method === "readArrayBuffer").length, 2);
  h.held.success({ code: 200, data: '{"ok":true}' });
  await promise;
});

test("preflight failure requests legacy fallback before metadata or cover reads", async () => {
  const h = harness({ fetch(params) { params.fail("offline", 1); } });
  const result = await h.run([h.book("a", 200)]);
  assert.equal(result.fallback, true);
  assert.equal(h.reads.length, 0);
  assert.ok(h.sent.every((p) => !p.url.endsWith("/metadata")));
});

test("HTTP failure after metadata is attempted does not silently switch transport", async () => {
  const h = harness({ fetch(params) {
    if (params.url.endsWith("/metadata")) return params.fail("response lost", 1);
    params.success({ code: 200, data: JSON.stringify(params.url.endsWith("/control/health")
      ? { service: "bandcomic-local-http", instanceId: "host", capabilities: { httpDataSync: 1 } } : { ok: true }) });
  } });
  await assert.rejects(h.run([h.book("a", 200)]), /response lost/);
  assert.equal(h.sent.filter((p) => p.url.endsWith("/metadata")).length, 2);
  assert.equal(h.reads.length, 0);
});

test("missing, oversized and short-read covers are explicit skips, not incomplete success", async () => {
  const h = harness({ read(params, bytes) {
    return { buffer: bytes.slice(params.position, params.position + params.length - 1) };
  } });
  const books = [h.book("short", 200), h.book("large", 2097153), { id: "missing", name: "Empty", page_count: 0, chapters: 0 }];
  const result = await h.run(books);
  assert.equal(result.skipped, 3);
  const skips = h.sent.filter((p) => p.url.endsWith("/skip")).map((p) => JSON.parse(p.data));
  assert.deepEqual(skips.map((p) => p.reason), ["short-read", "too-large", "missing"]);
  assert.equal(h.reads.filter((p) => p.method === "readArrayBuffer").length, 1);
});

test("cancelled sync ignores a late native POST response and emits no further requests", async () => {
  const h = harness({ fetch(params, state) { state.held = params; } });
  const promise = h.run([h.book("a", 200)]);
  h.current = false;
  h.held.success({ code: 200, data: '{"service":"bandcomic-local-http","instanceId":"host","capabilities":{"httpDataSync":1}}' });
  await assert.rejects(promise, /cancelled/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.reads.length, 0);
});

test("metadata batches are bounded with long non-ASCII names and preserve every ID", async () => {
  const h = harness();
  const books = Array.from({ length: 19 }, (_, i) => ({ id: "book" + i, name: "漫".repeat(1300), page_count: 0, chapters: 0 }));
  await h.run(books);
  const batches = h.sent.filter((p) => p.url.endsWith("/metadata") && JSON.parse(p.data).kind === "comics");
  assert.ok(batches.length >= 2);
  assert.ok(batches.every((p) => Buffer.byteLength(p.data) <= 65536));
  assert.deepEqual(batches.flatMap((p) => JSON.parse(p.data).items.map((item) => item.id)), books.map((b) => b.id));
});
