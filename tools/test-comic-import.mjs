// Real import commit/storage/reader/HTTP and QAIC entry points, with bounded fake Vela I/O.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const read = (name) => fs.readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
const strip = (code) => code.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export \{[^\n]*;\r?\n/gm, "").replace(/^export /gm, "");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const jpeg = (label) => Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.from(label)]);
function lvgl(label) {
  const bytes = Buffer.alloc(1028 + 16); bytes.writeUInt32LE(10 | (4 << 10) | (4 << 21)); bytes.write(label, 1028); return bytes;
}

function harness() {
  const h = { files: new Map(), dirs: new Set(), calls: [], pending: [], sent: [], routes: [], requests: [], fault: null, hold: null };
  const path = (uri) => uri.replace(/\/$/, "");
  const dispatch = (method, options, work) => {
    h.calls.push({ method, ...options });
    const finish = () => { const code = h.fault && h.fault(method, options); if (code) options.fail("injected", code); else work(); };
    if (h.hold && h.hold(method, options)) h.pending.push({ method, options, finish }); else finish();
  };
  const scan = (root) => [
    ...[...h.dirs].filter((d) => d.startsWith(root + "/") && !d.slice(root.length + 1).includes("/"))
      .map((uri) => ({ uri, type: "dir", subFiles: scan(uri) })),
    ...[...h.files].filter(([p]) => p.startsWith(root + "/") && !p.slice(root.length + 1).includes("/"))
      .map(([uri, bytes]) => ({ uri, type: "file", length: bytes.length })),
  ];
  const file = {
    readText(o) { dispatch("readText", o, () => h.files.has(o.uri) ? o.success({ text: h.files.get(o.uri) }) : o.fail("missing", 301)); },
    writeText(o) { dispatch("writeText", o, () => { h.files.set(o.uri, o.text); o.success(); }); },
    move(o) { dispatch("move", o, () => {
      if (!h.files.has(o.srcUri)) { o.fail("missing", 301); return; }
      h.files.set(o.dstUri, h.files.get(o.srcUri)); h.files.delete(o.srcUri); o.success();
    }); },
    delete(o) { dispatch("delete", o, () => { h.files.delete(o.uri); if (o.success) o.success(); }); },
    access(o) { dispatch("access", o, () => h.files.has(o.uri) || h.dirs.has(path(o.uri)) ? o.success() : o.fail("missing", 301)); },
    mkdir(o) { dispatch("mkdir", o, () => { h.dirs.add(o.uri); o.success(); }); },
    rmdir(o) { dispatch("rmdir", o, () => {
      const root = path(o.uri);
      for (const p of [...h.files.keys()]) if (p.startsWith(root + "/")) h.files.delete(p);
      for (const p of [...h.dirs]) if (p === root || p.startsWith(root + "/")) h.dirs.delete(p);
      if (o.success) o.success();
    }); },
    get(o) { dispatch("get", o, () => h.files.has(o.uri) ? o.success({ type: "file", length: h.files.get(o.uri).length }) :
      h.dirs.has(path(o.uri)) ? o.success({ type: "dir", subFiles: scan(path(o.uri)) }) : o.fail("missing", 301)); },
    list(o) { dispatch("list", o, () => o.success({ fileList: scan(path(o.uri)) })); },
    readArrayBuffer(o) { dispatch("readArrayBuffer", o, () => {
      const bytes = h.files.get(o.uri);
      if (!bytes) { o.fail("missing", 301); return; }
      o.success({ buffer: Uint8Array.from(bytes.subarray(o.position || 0, (o.position || 0) + o.length)) });
    }); },
    writeArrayBuffer(o) { dispatch("writeArrayBuffer", o, () => { h.files.set(o.uri, Buffer.from(o.buffer)); o.success(); }); },
  };
  const global = { APP_SETTING: {}, API_SETTING: { using: "Test" }, getTime: () => "12:00",
    $route: { parseParam: (v) => typeof v === "string" ? JSON.parse(v) : v } };
  const quiet = { debug() {}, warn() {}, error() {} };
  const context = vm.createContext({ file, global, console: quiet, Promise, ArrayBuffer, Uint8Array, URL,
    setTimeout, clearTimeout, prompt: { showToast() {} },
    isNativeFetchSupported: () => true,
    gatewayFetch: async (options) => {
      h.requests.push(options);
      if (options.method === "POST") return { statusCode: 200, data: {} };
      if (options.url.endsWith("/control/health")) return { statusCode: 200, data: { service: "bandcomic-local-http" } };
      if (options.url.endsWith("/probe.jpg")) { h.files.set("internal://files/_icf_probe", jpeg("probe")); return { statusCode: 200, data: "internal://files/_icf_probe" }; }
      if (h.task && options.url.endsWith("/control/tasks/" + h.task.taskId)) return { statusCode: 200, data: h.task };
      if (options.url.endsWith("/config")) return { statusCode: 200, data: { LocalUpload: {
        apiUrl: "http://host:1234", detailPath: "/book/<id>", photoPath: "/pages/<id>/<chapter>" } } };
      if (options.url.endsWith("/book/snapshot")) return { statusCode: 200, data: {
        item_id: "snapshot", name: h.task.name, total_chapters: h.task.totalChapters || 1,
        page_count: h.task.chapters.reduce((n, c) => n + c.pageCount, 0), cover: "" } };
      if (options.responseType === "text") {
        const number = +options.url.split("/").pop();
        const chapter = h.task.chapters.find((c) => c.chapterNum === number);
        return { statusCode: 200, data: JSON.stringify({ title: chapter.title,
          images: Array.from({ length: chapter.pageCount }, (_, i) => ({ url: `http://host:1234/image/${number}/${i + 1}` })) }) };
      }
      const uri = "internal://files/_icf_" + h.requests.length;
      h.files.set(uri, jpeg("HTTP new page"));
      return { statusCode: 200, data: uri };
    },
    require(name) {
      if (name === "@system.file") return file;
      if (name === "@system.router") return { push: (route) => h.routes.push(route) };
      if (name === "@system.prompt") return { showToast() {} };
      throw new Error(name);
    },
  });
  const nativeRequest = context.gatewayFetch;
  context.gatewayFetch = (options) => nativeRequest(options).then((response) => {
    if (options.success) options.success(response);
    return response;
  }, (error) => { if (options.fail) options.fail(error, error.code || 300); throw error; });
  for (const name of ["httpResponse", "jsonUtils", "imageUrl", "imageFile", "storage", "sourceConfig", "api", "comicImport", "gatewaySession",
    "base64", "stopWaitQueue", "windowedSender", "httpDataSync", "dataDelete", "dataBridge"]) {
    vm.runInContext(strip(read("components/" + name + ".js")), context);
  }
  vm.runInContext(`global.$storage = { updateComicMeta, readComics, isAlreadyExistsError, sanitizeFolderName, acquireComicMutation,
    comicCoverUri, scanComicStorage, comicContentIdentity, readHistory, updateJsonFile, HISTORY_URI };
    global.$api = { buildPhotoUrl, getHttpStatus, isHttpSuccess, FETCH_ERROR, getCurrentSource };
    global.$img = { addImageParams, addCoverParams, appendCoverSuffix, appendLvglSuffix };
    global.$imageFile = { isValidImageFile, deleteImageTemp };
    global.$gateway = { getDownloadContext, requestDownload, pageSaved, commitDownload, finishDownload };
    global.$comicImport = { beginComicImport, commitComicImport, abortComicImport };`, context);
  h.context = context; h.file = file; h.global = global;
  h.books = () => JSON.parse(h.files.get("internal://files/comics.json") || "[]");
  h.putBooks = (books) => h.files.set("internal://files/comics.json", JSON.stringify(books));
  h.stage = (tx, label = "new", bin = false, cover = false) => {
    const root = "internal://files/" + tx.stageId; h.dirs.add(root);
    for (const c of tx.plan.chapters) {
      const dir = tx.plan.isSerial ? root + "/" + c.chapterNum + "　" + c.title.replace(/[\\/:*?"<>|]/g, "_") : root;
      h.dirs.add(dir);
      for (let n = 1; n <= c.pageCount; n++) h.files.set(dir + "/" + n + (bin ? ".bin" : ""), bin ? lvgl(label) : jpeg(label));
    }
    if (cover) h.files.set(root + "/cover", jpeg("cover"));
  };
  h.bridge = context.createDataBridge({ send(o) { h.sent.push(JSON.parse(JSON.stringify(o.data))); if (o.success) o.success(); } });
  h.message = (data) => h.bridge.handleMessage({ data: JSON.stringify(data) });
  h.mount = async () => {
    const pageContext = vm.createContext({ global, file, console: quiet, Promise,
      router: { replace() {} }, prompt: { showToast() {} }, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout });
    vm.runInContext(read("pages/download/download.ux").match(/<script>([\s\S]*?)<\/script>/)[1]
      .replace(/^import .*;\r?\n/gm, "").replace("export default ", "globalThis.definition = "), pageContext);
    const page = Object.assign({}, pageContext.definition, JSON.parse(JSON.stringify(pageContext.definition.private)),
      { gatewayTaskId: h.task.taskId, $t: (key) => key });
    const promise = page.onInit();
    return { page, promise };
  };
  return h;
}

const plan = (numbers, extra = {}) => ({ importChapterProtocol: 1, operation: "upsert_chapters", bookId: "book_A", name: "漫画 A",
  isSerial: true, chapters: numbers.map((n) => ({ chapterNum: n, title: "第" + n + "章", pageCount: 2 })), ...extra });

test("append and update preserve stable identity, cover, other chapters and reading history", async () => {
  const h = harness();
  let tx = await h.context.beginComicImport(plan([1])); h.stage(tx, "first", false, true);
  await h.context.commitComicImport(tx, true);
  const first = h.books()[0];
  h.files.set("internal://files/history.json", JSON.stringify([{ id: "local_" + first.id, originalId: first.id, chapterNum: 1, page: 2 }]));
  tx = await h.context.beginComicImport(plan([2])); h.stage(tx, "second"); await h.context.commitComicImport(tx, false);
  assert.equal(h.books().length, 1); assert.equal(h.books()[0].id, first.id);
  assert.deepEqual(h.books()[0].chapters.map((c) => c.num), [1, 2]);
  assert.equal(h.context.comicCoverUri(h.books()[0]), "internal://files/" + first.storageId + "/cover");
  const oldChapter = h.books()[0].chapters[1];
  tx = await h.context.beginComicImport(plan([2], { name: "Different draft name", chapters: [{ chapterNum: 2, title: "改/名", pageCount: 1 }] }));
  h.stage(tx, "updated", true); await h.context.commitComicImport(tx, false);
  const book = h.books()[0]; assert.equal(book.name, "漫画 A"); assert.equal(book.page_count, 3);
  assert.equal(book.chapters[1].name, "改_名");
  assert.ok(h.files.has(h.context.comicChapterUri(book, book.chapters[0]) + "/1"));
  assert.ok(h.files.has(h.context.comicChapterUri(book, book.chapters[1]) + "/1.bin"));
  assert.ok(!h.files.has("internal://files/" + oldChapter.storageId + "/2　第2章/2"));
  assert.equal(JSON.parse(h.files.get("internal://files/history.json"))[0].page, 2);
});

for (const fault of ["bad-page", "missing-page", "index-write", "cancel"]) {
  test("failed chapter update preserves the complete old version: " + fault, async () => {
    const h = harness(); let tx = await h.context.beginComicImport(plan([1])); h.stage(tx, "old"); await h.context.commitComicImport(tx, false);
    const before = h.files.get("internal://files/comics.json");
    tx = await h.context.beginComicImport(plan([1])); h.stage(tx, "replacement");
    const page = "internal://files/" + tx.stageId + "/1　第1章/1";
    if (fault === "bad-page") h.files.set(page, Buffer.from("<html>login</html>"));
    if (fault === "missing-page") h.files.delete(page);
    if (fault === "index-write") h.fault = (method) => method === "writeText" ? 300 : null;
    if (fault === "cancel") h.context.abortComicImport(tx);
    await assert.rejects(h.context.commitComicImport(tx, false));
    assert.equal(h.files.get("internal://files/comics.json"), before);
    const book = h.books()[0]; assert.ok(h.files.has(h.context.comicChapterUri(book, book.chapters[0]) + "/1"));
  });
}

test("replace book changes only the explicit same-name target and preserves its logical history identity", async () => {
  const h = harness();
  for (const bookId of ["one", "two"]) { const tx = await h.context.beginComicImport(plan([1, 2], { bookId })); h.stage(tx); await h.context.commitComicImport(tx, false); }
  const untouched = h.books().find((b) => b.bookId === "two");
  const tx = await h.context.beginComicImport(plan([5], { bookId: "fresh_draft", targetComicId: "local_one", operation: "replace_book" }));
  h.stage(tx); await h.context.commitComicImport(tx, false);
  assert.deepEqual(h.books().find((b) => b.id === "local_one").chapters.map((c) => c.num), [5]);
  assert.deepEqual(h.books().find((b) => b.bookId === "two"), untouched);
});

test("ambiguous/stale/online targets and duplicate chapter numbers never start a write", async () => {
  const h = harness(); h.putBooks([{ id: "online", bookId: "book_A", is_serial: true }]);
  await assert.rejects(h.context.beginComicImport(plan([1])));
  await assert.rejects(h.context.beginComicImport(plan([1], { targetComicId: "local_missing" })));
  await assert.rejects(h.context.beginComicImport(plan([2, 2], { bookId: "other" })));
  assert.equal(h.calls.filter((c) => c.method === "writeText").length, 0);
});

test("cleaning, scanning and deleting follow all roots of a merged book", async () => {
  const h = harness();
  for (const number of [1, 2]) { const tx = await h.context.beginComicImport(plan([number])); h.stage(tx); await h.context.commitComicImport(tx, false); }
  const book = h.books()[0]; const stats = await h.context.scanComicStorage(book);
  assert.deepEqual([...stats.chapters].map((c) => c.downloaded), [2, 2]);
  await h.context.cleanTempFiles();
  for (const c of book.chapters) assert.ok(h.files.has(h.context.comicChapterUri(book, c) + "/1"));
  const result = await h.context.deleteComicById(book.id);
  assert.equal(result.status, "success"); assert.equal(h.books().length, 0);
  for (const c of book.chapters) assert.ok(!h.files.has(h.context.comicChapterUri(book, c) + "/1"));
});

test("cancel retains target and stage ownership until native writes return", async () => {
  const h = harness(); const tx = await h.context.beginComicImport(plan([1])); h.stage(tx);
  const release = tx.lease.retain(); h.context.abortComicImport(tx);
  assert.equal(h.context.acquireComicMutation(tx.targetId), null);
  await h.context.cleanTempFiles(); assert.ok(h.dirs.has("internal://files/" + tx.stageId));
  release(); assert.ok(!h.dirs.has("internal://files/" + tx.stageId));
  const owner = h.context.acquireComicMutation(tx.targetId); assert.ok(owner); owner.release();
});

test("cancellation during submitted atomic index write settles as committed and does not delete the new version", async () => {
  const h = harness(); const tx = await h.context.beginComicImport(plan([1])); h.stage(tx);
  h.hold = (method) => method === "writeText";
  const commit = h.context.commitComicImport(tx, false); await tick();
  assert.equal(tx.commitStarted, true); h.context.abortComicImport(tx);
  h.pending.shift().finish(); await commit;
  assert.equal(tx.committed, true); assert.ok(h.files.has(h.context.comicChapterUri(h.books()[0], h.books()[0].chapters[0]) + "/1"));
});

for (const number of [1, 5, 100000]) {
  test("HTTP real download page commits a single selected chapter as a serial book: " + number, async () => {
    const h = harness(); h.task = { ...plan([number]), taskId: "task_http", comicId: "snapshot", totalChapters: number, imageProfile: {} };
    await h.context.handleGatewayBind({ endpoint: "http://host:1234", session: "bound" }, { send() {} });
    await h.context.handleImportHttpTask({ taskId: "task_http", endpoint: "http://host:1234" });
    assert.equal(h.routes.length, 1);
    const { page, promise } = await h.mount(); await promise;
    for (let n = 0; n < 30 && !h.requests.some((r) => r.url.endsWith("/result")); n++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(page.downloadError, "", String(page.downloadError));
    assert.equal(page.chapterList.length, 1, "sparse high chapter numbers must not allocate all preceding chapters");
    assert.equal(h.books().length, 1, JSON.stringify({ requests: h.requests.map((r) => [r.url, r.data]),
      failed: page._downloadState.failedChapters, draft: page._downloadState.gateway.transaction.draft }));
    assert.deepEqual(h.books()[0].chapters.map((c) => c.num), [number]); assert.equal(h.books()[0].is_serial, true);
    assert.equal(h.requests.filter((r) => r.url.endsWith("/result")).at(-1) && JSON.parse(h.requests.filter((r) => r.url.endsWith("/result")).at(-1).data).success, true);
    page.onDestroy();
  });
}

test("QAIC actual header/chunks/done append chapters under the same book and replay the accepted header", async () => {
  const h = harness();
  for (const number of [1, 2]) {
    const header = { ...plan([number]), type: "import_comic_header", sessionId: "session_" + number, mode: "multi",
      chapters: [{ chapterNum: number, title: "第" + number + "章", name: number + "　第" + number + "章", pageCount: 1, files: ["1"] }] };
    h.message(header); await tick();
    assert.equal(h.sent.at(-1).type, "import_header_ack");
    h.message(header); await tick(); assert.equal(h.sent.at(-1).type, "import_header_ack");
    h.message({ type: "import_comic_chunk", sessionId: header.sessionId, name: header.name, file: header.chapters[0].name + "/1", index: 0, total: 1, data: jpeg("wire page").toString("base64") });
    h.message({ type: "import_comic_done", sessionId: header.sessionId, name: header.name }); await tick();
    const result = h.sent.filter((m) => m.type === "import_comic_result").at(-1);
    assert.equal(result.success, true); assert.equal(result.savedPages, 1);
  }
  assert.equal(h.books().length, 1); assert.deepEqual(h.books()[0].chapters.map((c) => c.num), [1, 2]);
});

test("HTTP real page appends and replaces a chapter without indexing preparation or changing an old chapter", async () => {
  const h = harness();
  await h.context.handleGatewayBind({ endpoint: "http://host:1234", session: "bound" }, { send() {} });
  for (const [index, number, count] of [[1, 1, 2], [2, 2, 2], [3, 2, 1]]) {
    h.task = { ...plan([number], { chapters: [{ chapterNum: number, title: "第" + number + "章", pageCount: count }] }),
      taskId: "task_" + index, comicId: "snapshot", totalChapters: 2, imageProfile: {} };
    const before = h.files.get("internal://files/comics.json");
    await h.context.handleImportHttpTask({ taskId: h.task.taskId });
    assert.equal(h.files.get("internal://files/comics.json"), before, "preparation must not publish a partial replacement");
    const { page, promise } = await h.mount(); await promise;
    const resultUrl = "/control/tasks/" + h.task.taskId + "/result";
    for (let n = 0; n < 30 && !h.requests.some((r) => r.url.endsWith(resultUrl)); n++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(JSON.parse(h.requests.find((r) => r.url.endsWith(resultUrl)).data).success, true);
    page.onDestroy();
  }
  const book = h.books()[0]; assert.equal(h.books().length, 1);
  assert.deepEqual(book.chapters.map((c) => [c.num, c.page_count]), [[1, 2], [2, 1]]);
  assert.ok(h.files.has(h.context.comicChapterUri(book, book.chapters[0]) + "/2"));
});

test("real offline chapter mapping and photo reader follow selected versions and clamp restored page", async () => {
  const h = harness();
  for (const number of [1, 5]) { const tx = await h.context.beginComicImport(plan([number], {
    chapters: [{ chapterNum: number, title: "第" + number + "章", pageCount: 1 }] })); h.stage(tx, "read", number === 5); await h.context.commitComicImport(tx, false); }
  h.global.$set = {}; h.global.$cover = {}; h.global.$delete = {};
  h.global.createConfirmGuard = () => () => false;
  const context = vm.createContext({ global: h.global, file: h.file, console: { debug() {} }, Promise,
    router: { push: (route) => h.routes.push(route) }, prompt: { showToast() {} } });
  const definition = (name, key) => vm.runInContext(read("pages/" + name + "/" + name + ".ux")
    .match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, "")
    .replace("export default ", "globalThis." + key + " = "), context);
  definition("offline", "offline");
  const book = h.books()[0]; context.offline.applyComicMeta(book);
  assert.equal(book.totalChapter[1][3], book.chapters[1].storageId);
  const photoContext = vm.createContext({ global: h.global, file: h.file, console: { debug() {} }, prompt: { showToast() {} } });
  vm.runInContext(read("pages/photo/photo.ux").match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*;\r?\n/gm, "").replace("export default ", "globalThis.photo = "), photoContext);
  const page = Object.assign({}, photoContext.photo, JSON.parse(JSON.stringify(photoContext.photo.private)), {
    id: book.id, local: true, is_serial: true, downloadChapter: book.totalChapter, chapter: 1, page: 50,
    _photoReadGeneration: 1, _photoImageSeq: 0, destroyed: false, $t: (key) => key,
  });
  page.initData({ chapterNum: 5, page: 50 });
  assert.equal(page.chapter, 2); assert.equal(page.page, 1);
  assert.equal(page.images, h.context.comicChapterUri(book, book.chapters[1]) + "/1.bin");
  const tx = await h.context.beginComicImport(plan([5], { chapters: [{ chapterNum: 5, title: "更新章", pageCount: 1 }] }));
  h.stage(tx, "new reader version"); await h.context.commitComicImport(tx, false);
  page.onShow(); await tick();
  const updated = h.books()[0];
  assert.equal(page.images, h.context.comicChapterUri(updated, updated.chapters[1]) + "/1");
});

test("QAIC rejects unsafe paths before ACK and a failed replacement keeps old content", async () => {
  const h = harness(); const tx = await h.context.beginComicImport(plan([1])); h.stage(tx); await h.context.commitComicImport(tx, false);
  const before = h.files.get("internal://files/comics.json");
  const header = { ...plan([1]), type: "import_comic_header", sessionId: "invalid", mode: "multi",
    chapters: [{ chapterNum: 1, title: "第1章", name: "../outside", pageCount: 1, files: ["1"] }] };
  h.message(header); await tick(); assert.equal(h.sent.at(-1).type, "import_comic_result");
  assert.equal(h.sent.at(-1).success, false);
  header.sessionId = "bad_image"; header.chapters[0].name = "1　第1章";
  h.message(header); await tick();
  h.message({ type: "import_comic_chunk", name: header.name, sessionId: header.sessionId, file: "1　第1章/1",
    index: 0, total: 1, data: Buffer.from("<html>bad page</html>").toString("base64") });
  h.message({ type: "import_comic_done", sessionId: header.sessionId }); await tick();
  assert.equal(h.sent.at(-1).success, false); assert.equal(h.files.get("internal://files/comics.json"), before);
});

test("old plugin whole-book replacement removes inherited version pointers and collects all old roots", async () => {
  const h = harness();
  for (const number of [1, 2]) { const tx = await h.context.beginComicImport(plan([number])); h.stage(tx); await h.context.commitComicImport(tx, false); }
  const previous = h.books()[0];
  h.message({ type: "import_comic_header", sessionId: "old_plugin", name: previous.name, mode: "single", files: ["1"] });
  h.message({ type: "import_comic_chunk", sessionId: "old_plugin", name: previous.name, file: "1", index: 0, total: 1, data: jpeg("old plugin valid page").toString("base64") });
  h.message({ type: "import_comic_done", sessionId: "old_plugin" }); await tick();
  const book = h.books()[0]; assert.equal(h.books().length, 1); assert.equal(book.storageId, undefined);
  assert.equal(book.bookId, undefined); assert.ok(h.files.has("internal://files/" + book.id + "/1"));
  for (const root of h.context.comicStorageIds(previous)) assert.ok(!h.dirs.has("internal://files/" + root));
});

test("legacy same-name ambiguity and failed legacy replacement preserve prior imported books", async () => {
  const h = harness();
  for (const bookId of ["one", "two"]) { const tx = await h.context.beginComicImport(plan([1], { bookId })); h.stage(tx); await h.context.commitComicImport(tx, false); }
  const previous = h.books();
  h.message({ type: "import_comic_header", sessionId: "ambiguous", name: "漫画 A", mode: "single", files: ["1"] });
  h.message({ type: "import_comic_chunk", sessionId: "ambiguous", name: "漫画 A", file: "1", index: 0, total: 1, data: jpeg("legacy").toString("base64") });
  h.message({ type: "import_comic_done", sessionId: "ambiguous" }); await tick();
  assert.equal(h.books().length, 3);
  for (const book of previous) assert.ok(h.books().some((c) => c.id === book.id));
  h.message({ type: "import_comic_header", sessionId: "missing", name: "漫画 A", mode: "single", files: ["1", "2"] });
  h.message({ type: "import_comic_done", sessionId: "missing" }); await tick();
  for (const book of previous) assert.ok(h.files.has(h.context.comicChapterUri(book, book.chapters[0]) + "/1"));
});

test("multi-root deletion failure retains a retryable partial record and retry removes all references", async () => {
  const h = harness();
  for (const number of [1, 2]) { const tx = await h.context.beginComicImport(plan([number])); h.stage(tx); await h.context.commitComicImport(tx, false); }
  const book = h.books()[0];
  h.fault = (method, options) => method === "rmdir" && options.uri.includes(book.chapters[1].storageId) ? 300 : null;
  const partial = await h.context.deleteComicById(book.id);
  assert.equal(partial.status, "partial"); assert.equal(h.books().length, 1);
  assert.ok(h.files.has(h.context.comicChapterUri(book, book.chapters[1]) + "/1"));
  h.fault = null;
  assert.equal((await h.context.deleteComicById(book.id)).status, "success"); assert.equal(h.books().length, 0);
});
