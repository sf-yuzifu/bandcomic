// Exercise the real delete executor, storage queue/atomic writes and request controller.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = (name) => fs.readFileSync(new URL("../src/components/" + name, import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness() {
  const files = new Map(), dirs = new Set(), calls = [], pending = [], results = [];
  const h = { files, dirs, calls, pending, results, fault: null, hold: null };
  const path = (uri) => uri.replace(/\/$/, "");
  const dispatch = (method, options, work) => {
    calls.push({ method, uri: options.uri || options.dstUri });
    const finish = () => {
      const code = h.fault && h.fault(method, options);
      if (code) options.fail("injected", code);
      else work();
    };
    if (h.hold && h.hold(method, options)) pending.push({ method, options, finish });
    else finish();
  };
  const file = {
    readText(o) { dispatch("readText", o, () => files.has(o.uri) ? o.success({ text: files.get(o.uri) }) : o.fail("missing", 301)); },
    writeText(o) { dispatch("writeText", o, () => { files.set(o.uri, o.text); o.success(); }); },
    move(o) { dispatch("move", o, () => {
      if (!files.has(o.srcUri)) { o.fail("missing", 301); return; }
      files.set(o.dstUri, files.get(o.srcUri)); files.delete(o.srcUri); o.success();
    }); },
    delete(o) { dispatch("delete", o, () => { files.delete(o.uri); o.success(); }); },
    access(o) { dispatch("access", o, () => files.has(o.uri) || dirs.has(path(o.uri)) ? o.success() : o.fail("missing", 301)); },
    rmdir(o) { dispatch("rmdir", o, () => {
      const root = path(o.uri);
      if (!dirs.has(root)) { o.fail("missing", 301); return; }
      for (const key of [...files.keys()]) if (key.startsWith(root + "/")) files.delete(key);
      for (const key of [...dirs]) if (key === root || key.startsWith(root + "/")) dirs.delete(key);
      o.success();
    }); },
    get(o) { dispatch("get", o, () => {
      const root = path(o.uri);
      if (!dirs.has(root)) { o.fail("missing", 301); return; }
      o.success({ subFiles: [...files.keys()].filter((key) => key.startsWith(root + "/")).map((uri) => ({ uri, type: "file" })) });
    }); },
  };
  const global = { API_SETTING: {}, DEFAULT_API_SETTING: { Default: { name: "Default" } } };
  const context = vm.createContext({ file, global, console: { debug() {}, warn() {}, error() {} } });
  const strip = (code) => code.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext(strip(source("storage.js")), context);
  vm.runInContext(source("api.js").match(/export function ensureUsingSourceValid\(\) \{[\s\S]*?\n\}/)[0].replace("export ", ""), context);
  vm.runInContext(strip(source("dataDelete.js")) + "\nglobalThis.hooks = { deviceDeletes, createDeleteController, deleteComicById, acquireComicMutation, updateComicMeta };", context);
  h.hooks = context.hooks;
  h.global = global;
  h.book = (id, name = "Same") => {
    const list = JSON.parse(files.get("internal://files/comics.json") || "[]");
    list.push({ id, name }); files.set("internal://files/comics.json", JSON.stringify(list));
    dirs.add("internal://files/" + id); files.set("internal://files/" + id + "/1", "page");
  };
  h.books = () => JSON.parse(files.get("internal://files/comics.json"));
  h.session = (id) => h.hooks.deviceDeletes.beginSession(id);
  h.request = (fields = {}) => ({ type: "delete_item", protocol: 1, session: "hs1", requestId: "del_1", kind: "comic", comicId: "one", ...fields });
  h.send = (msg) => h.hooks.deviceDeletes.handle(msg, (result) => results.push(clone(result)));
  h.finish = async () => { assert.ok(pending.length); pending.shift().finish(); await tick(); };
  return h;
}

test("same-name comics: only specified full ID is removed; success waits for rmdir and atomic index commit", async () => {
  const h = harness(); h.book("one"); h.book("two"); h.session("hs1");
  h.hold = (method) => method === "rmdir" || method === "writeText";
  h.send(h.request({ comicId: "two" })); await tick();
  assert.equal(h.results.length, 0);
  assert.equal(h.pending[0].options.uri, "internal://files/two/");
  await h.finish();
  assert.equal(h.results.length, 0, "file removal is not index commit");
  assert.equal(h.books().length, 2);
  await h.finish();
  assert.equal(h.results[0].status, "success");
  assert.deepEqual(h.books().map((b) => b.id), ["one"]);
  assert.ok(h.files.has("internal://files/one/1"));
  assert.ok(!h.files.has("internal://files/two/1"));
});

for (const method of ["access", "rmdir"]) {
  test(method + " I/O failure retains the retryable index and never reports success", async () => {
    const h = harness(); h.book("one"); h.session("hs1");
    h.fault = (op) => op === method ? 300 : null;
    h.send(h.request()); await tick();
    assert.equal(h.results[0].status, "failed");
    assert.equal(h.books().length, 1);
    assert.ok(h.files.has("internal://files/one/1"));
  });
}

test("index failure is partial; a new retry removes the retained record after confirming directory absence", async () => {
  const h = harness(); h.book("one"); h.session("hs1");
  h.fault = (method) => method === "writeText" ? 300 : null;
  h.send(h.request()); await tick();
  assert.equal(h.results[0].status, "partial");
  assert.equal(h.results[0].filesState, "removed");
  assert.equal(h.books().length, 1);
  h.fault = null;
  h.send(h.request({ requestId: "del_retry" })); await tick();
  assert.equal(h.results[1].status, "success");
  assert.equal(h.results[1].filesState, "missing");
  assert.deepEqual(h.books(), []);
});

test("duplicate pending/completed messages and conflicts never execute another deletion", async () => {
  const h = harness(); h.book("one"); h.book("two"); h.session("hs1");
  h.hold = (method) => method === "rmdir";
  h.send(h.request()); await tick();
  h.send(h.request());
  assert.equal(h.results[0].status, "processing");
  h.send(h.request({ comicId: "two" }));
  assert.equal(h.results[1].code, "REQUEST_CONFLICT");
  await h.finish();
  h.send(h.request());
  assert.equal(h.results.at(-1).status, "success");
  assert.equal(h.calls.filter((c) => c.method === "rmdir").length, 1);
  assert.deepEqual(h.books().map((b) => b.id), ["two"]);
});

test("refresh handshake preserves an in-flight request and lost result can be queried using original identity", async () => {
  const h = harness(); h.book("one"); h.session("hs1");
  h.hold = (method) => method === "rmdir";
  h.send(h.request()); await tick(); h.session("hs2");
  await h.finish();
  h.results.length = 0; // final result lost
  h.send(h.request({ type: "delete_status", session: "hs2", requestSession: "hs1" }));
  assert.equal(h.results[0].status, "success");
  assert.equal(h.results[0].session, "hs1");
  assert.equal(h.calls.filter((c) => c.method === "rmdir").length, 1);
});

test("unknown result after device restart is not a new execution; old session cannot delete re-created content", async () => {
  const h = harness(); h.book("one"); h.session("hs1");
  h.send(h.request()); await tick(); h.book("one", "New copy");
  const restarted = h.hooks.createDeleteController(() => { throw new Error("must not execute"); });
  restarted.beginSession("hs2");
  const results = [];
  restarted.handle(h.request({ type: "delete_status", session: "hs2", requestSession: "hs1" }), (r) => results.push(r));
  restarted.handle(h.request(), (r) => results.push(r));
  assert.equal(results[0].status, "unknown");
  assert.equal(results[1].code, "SESSION_EXPIRED");
  assert.ok(h.files.has("internal://files/one/1"));
});

test("bounded request cache never evicts active-session identities into re-execution", async () => {
  const h = harness(); let executed = 0;
  const controller = h.hooks.createDeleteController(() => { executed++; return { status: "success" }; });
  controller.beginSession("hs1");
  for (let i = 0; i < 32; i++) { controller.handle(h.request({ requestId: "req_" + i }), () => {}); await tick(); }
  const results = [];
  controller.handle(h.request({ requestId: "req_32" }), (r) => results.push(r));
  controller.beginSession("hs2");
  controller.handle(h.request({ requestId: "req_0" }), (r) => results.push(r));
  assert.equal(executed, 32);
  assert.equal(results[0].code, "REQUEST_LIMIT");
  assert.equal(results[1].code, "SESSION_EXPIRED");
});

test("same-name sources are deleted only by exact key; disk and using pointer are committed before success", async () => {
  const h = harness();
  h.files.set("internal://files/sources.json", JSON.stringify([{ A: { name: "Same" } }, { B: { name: "Same" } }]));
  h.global.API_SETTING = { using: "B", A: { name: "Same" }, B: { name: "Same" } };
  h.session("hs1"); h.hold = (method) => method === "writeText";
  h.send(h.request({ kind: "source", comicId: undefined, sourceKey: "B" })); await tick();
  assert.equal(h.results.length, 0);
  assert.ok(h.global.API_SETTING.B);
  await h.finish();
  assert.equal(h.results[0].status, "success");
  assert.equal(h.global.API_SETTING.using, "A");
  assert.ok(!h.global.API_SETTING.B);
  assert.deepEqual(JSON.parse(h.files.get("internal://files/sources.json")), [{ A: { name: "Same" } }]);
});

test("source commit failure retains disk and memory; no false successful deletion", async () => {
  const h = harness(); h.files.set("internal://files/sources.json", '[{"A":{"name":"Same"}}]');
  h.global.API_SETTING = { using: "A", A: { name: "Same" } }; h.session("hs1");
  h.fault = (method) => method === "writeText" ? 300 : null;
  h.send(h.request({ kind: "source", sourceKey: "A" })); await tick();
  assert.equal(h.results[0].status, "failed");
  assert.ok(h.global.API_SETTING.A);
  assert.equal(JSON.parse(h.files.get("internal://files/sources.json")).length, 1);
});

test("malformed, missing and ambiguous targets never fall back to a matching name or arbitrary directory", async () => {
  const h = harness(); h.book("one"); h.session("hs1");
  for (const [requestId, comicId] of [["a", undefined], ["b", "../one"], ["c", "missing"]]) {
    h.send(h.request({ requestId, comicId, name: "Same" })); await tick();
    assert.equal(h.results.at(-1).status, "failed");
  }
  h.book("one"); h.send(h.request({ requestId: "d" })); await tick();
  assert.equal(h.results.at(-1).code, "TARGET_AMBIGUOUS");
  assert.equal(h.calls.filter((c) => c.method === "rmdir").length, 0);
});

test("a damaged index is not treated as an empty valid deletion target", async () => {
  const h = harness(); h.book("one"); h.files.set("internal://files/comics.json", "{broken"); h.session("hs1");
  h.send(h.request()); await tick();
  assert.equal(h.results[0].code, "INDEX_READ_FAILED");
  assert.ok(h.files.has("internal://files/one/1"));
  assert.equal(h.files.get("internal://files/comics.json.bad"), "{broken");
});

test("target write ownership survives parent release until native callback; delete returns busy", async () => {
  const h = harness(); h.book("one"); h.session("hs1");
  const lease = h.hooks.acquireComicMutation("one");
  const finishNative = lease.retain(); lease.release();
  h.send(h.request()); await tick();
  assert.equal(h.results[0].code, "TARGET_BUSY");
  finishNative();
  h.send(h.request({ requestId: "retry" })); await tick();
  assert.equal(h.results[1].status, "success");
});

test("device-page fallback retains the index when partial files or final access fail", async () => {
  const h = harness(); h.book("one");
  h.files.set("internal://files/one/2", "page2");
  h.fault = (method, options) => method === "rmdir" || (method === "delete" && options.uri.endsWith("/2")) ? 300 : null;
  const result = await h.hooks.deleteComicById("one", { fallback: true });
  assert.equal(result.status, "partial");
  assert.equal(h.books().length, 1);
  assert.ok(h.files.has("internal://files/one/2"));
});

test("late bookshelf scan metadata cannot recreate an index entry after a confirmed deletion", async () => {
  const h = harness(); h.book("one"); h.session("hs1");
  h.send(h.request()); await tick();
  assert.equal(h.results[0].status, "success");
  await h.hooks.updateComicMeta("one", (record) => ({ ...record, chapters:[{ downloaded:1 }] }), { requireExisting:true });
  assert.deepEqual(h.books(), []);
});

test("a stale result query cannot turn an executing deletion into a terminal failure", async () => {
  const h = harness(); h.book("one"); h.session("hs1"); h.hold = (method) => method === "rmdir";
  h.send(h.request()); await tick(); h.session("hs2");
  h.send(h.request({ type:"delete_status", requestSession:"hs1", session:"stale-query" }));
  assert.equal(h.results[0].status, "unknown");
  assert.equal(h.results[0].code, "SESSION_EXPIRED");
  await h.finish();
  assert.equal(h.results.at(-1).status, "success");
});

test("unexpected executor exception preserves unknown outcome instead of asserting no deletion happened", async () => {
  const h = harness();
  const controller = h.hooks.createDeleteController(() => { throw new Error("unexpected"); });
  controller.beginSession("hs1");
  const results = [];
  controller.handle(h.request(), (r) => results.push(r)); await tick();
  assert.equal(results[0].status, "unknown");
  assert.equal(results[0].indexState, "unknown");
});
