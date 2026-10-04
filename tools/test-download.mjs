// Run the real download page, image URL helpers and storage queue with fake Vela APIs.
// All network, files and timers stay in memory; delayed callbacks can arrive after exit.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const pageSource = read("../src/pages/download/download.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
const storageSource = read("../src/components/storage.js");
const imageSource = read("../src/components/imageUrl.js");
const imageFileSource = read("../src/components/imageFile.js");
const httpSource = read("../src/components/httpResponse.js");
const apiSource = read("../src/components/api.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => JSON.parse(JSON.stringify(value));
const noop = () => {};
const outcome = (promise) => promise.then(() => null, (error) => error);
const isAborted = (error) => assert.equal(error && error.message, "download aborted");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCz8AAAAASUVORK5CYII=", "base64");
function imageBytes(label, bin = false) {
  if (!bin) return Buffer.concat([PNG, Buffer.from(label)]);
  // Same indexed-8 layout as JM/MangaDex/QQ/Bilibili/E-Hentai converters.
  const width = 20, height = 10;
  const bytes = Buffer.alloc(4 + 1024 + width * height);
  bytes.writeUInt32LE((10 | (width << 10) | (height << 21)) >>> 0);
  for (let i = 0; i < 256; i++) bytes[4 + i * 4 + 3] = 255;
  bytes.write(label, 1028);
  return bytes;
}

function harness({ cancellable = false, bin = false } = {}) {
  const requests = [], calls = [], pending = [], routes = [], toasts = [], deleted = [];
  const files = new Map(), dirs = new Set(), holds = new Map(), timers = new Map();
  let clock = 0, timerSeq = 0, tempSeq = 0;
  function dispatch(type, options, run) {
    calls.push({ type, ...options });
    const finish = (code) => {
      if (code) options.fail("injected IO error", code);
      else run();
    };
    if (holds.get(type)?.(options)) pending.push({ type, options, finish });
    else finish();
  }
  function scan(uri) {
    const children = [];
    const prefix = uri + "/";
    for (const dir of dirs) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) {
        children.push({ uri: dir, type: "dir", subFiles: scan(dir) });
      }
    }
    for (const [path, content] of files) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
        children.push({ uri: path, type: "file", length: content.length });
      }
    }
    return children;
  }
  const file = {
    readText(options) {
      dispatch("readText", options, () => files.has(options.uri)
        ? options.success({ text: files.get(options.uri) }) : options.fail("missing", 301));
    },
    readArrayBuffer(options) {
      dispatch("readArrayBuffer", options, () => {
        if (!files.has(options.uri)) { options.fail("missing", 301); return; }
        const bytes = Buffer.from(files.get(options.uri));
        const start = options.position || 0;
        options.success({ buffer: new Uint8Array(bytes.subarray(start, start + options.length)) });
      });
    },
    writeText(options) {
      dispatch("writeText", options, () => {
        files.set(options.uri, options.text);
        options.success();
      });
    },
    access(options) {
      dispatch("access", options, () => files.has(options.uri) || dirs.has(options.uri)
        ? options.success() : options.fail("missing", 301));
    },
    mkdir(options) {
      dispatch("mkdir", options, () => {
        if (dirs.has(options.uri)) options.fail("exists", 202);
        else { dirs.add(options.uri); options.success(); }
      });
    },
    get(options) {
      dispatch("get", options, () => {
        if (dirs.has(options.uri)) options.success({ type: "dir", subFiles: scan(options.uri) });
        else if (files.has(options.uri)) options.success({ type: "file", length: files.get(options.uri).length });
        else options.fail("missing", 301);
      });
    },
    move(options) {
      dispatch("move", options, () => {
        assert.ok(files.has(options.srcUri), "move source must exist");
        files.set(options.dstUri, files.get(options.srcUri));
        files.delete(options.srcUri);
        options.success();
      });
    },
    delete(options) {
      deleted.push(options.uri);
      files.delete(options.uri);
      if (options.success) options.success();
    },
  };
  const quiet = { debug: noop, info: noop, error: noop };
  const storageContext = vm.createContext({ file, console: quiet, Promise });
  vm.runInContext(storageSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") +
    "\nglobalThis.storage = { updateComicMeta, isAlreadyExistsError, readComics, sanitizeFolderName, acquireComicMutation };", storageContext);
  const appGlobal = {
    API_SETTING: { using: "source", source: { apiUrl: "https://source.test", photoPath: "/photo/<id>/<chapter>" } },
    APP_SETTING: { imageSize: "480", imageQuality: "50", imagePreTranscode: bin, imageUsePng: bin },
    getTime: () => "12:00",
    $storage: storageContext.storage,
    $api: {
      apiFetch(options) {
        const request = { ...options, pending: true, cancelCount: 0 };
        requests.push(request);
        const task = Promise.resolve();
        if (cancellable) task.cancel = () => { request.cancelCount++; request.pending = false; };
        return task;
      },
      buildPhotoUrl: (id, chapter) => `https://source.test/photo/${id}/${chapter}`,
      getCurrentSource: () => appGlobal.API_SETTING[appGlobal.API_SETTING.using],
      FETCH_ERROR: { TIMEOUT: 28 },
    },
  };
  const imageContext = vm.createContext({ global: appGlobal, URL, file, Promise, ArrayBuffer, Uint8Array });
  vm.runInContext(httpSource.replace(/^export /gm, "") +
    "\nglobal.$api.getHttpStatus = getHttpStatus; global.$api.isHttpSuccess = isHttpSuccess;", imageContext);
  vm.runInContext(apiSource.replace(/^import .*;\r?\n/gm, "").replace(/^export \{[^\n]*\n/gm, "")
    .replace(/^export /gm, "") + "\nglobal.$api.buildPhotoUrl = buildPhotoUrl;", imageContext);
  vm.runInContext(imageSource.replace(/^export /gm, "") +
    "\nglobal.$img = { addUrlParam, addImageParams, addCoverParams, appendCoverSuffix, appendLvglSuffix };", imageContext);
  vm.runInContext(imageFileSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") +
    "\nglobal.$imageFile = { isValidImageFile, deleteImageTemp };", imageContext);
  const context = vm.createContext({
    global: appGlobal, console: quiet, file, Promise,
    router: { replace: (route) => routes.push(route), back: () => routes.push({ back: true }) },
    prompt: { showToast: (toast) => toasts.push(toast) },
    setTimeout(fn, delay) {
      const id = ++timerSeq;
      timers.set(id, { fn, at: clock + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(pageSource.replace(/^import .*;\r?\n/gm, "")
    .replace("export default ", "globalThis.definition = "), context);
  function instance(params = {}) {
    return Object.assign({}, context.definition, clone(context.definition.private), {
      id: "A", name: "Book A", chapter: 1, total_chapters: 2, cover: "",
      $t: (key, values) => key + (values ? JSON.stringify(values) : ""),
    }, params);
  }
  const h = {
    files, dirs, calls, pending, requests, routes, toasts, deleted, timers,
    global: appGlobal, instance,
    async mount(params) {
      const page = instance(params);
      await page.onInit();
      await tick();
      return page;
    },
    hold(type, predicate = () => true) { holds.set(type, predicate); },
    release(type) { holds.delete(type); },
    async finish(type, code) {
      const index = pending.findIndex((operation) => operation.type === type);
      assert.ok(index >= 0, `expected pending ${type}`);
      pending.splice(index, 1)[0].finish(code);
      await tick();
    },
    list(request, id, count = 2, title = id) {
      request.pending = false;
      request.success({ statusCode: 200, data: { title, images: Array.from({ length: count }, (_, index) => ({
        url: `https://images.test/${id}/${index + 1}`,
      })) } });
    },
    image(request, content, uri = `internal://files/_icf_test_${++tempSeq}`, response = { statusCode: 200 }) {
      request.pending = false;
      const bytes = Buffer.isBuffer(content) ? content : imageBytes(content, request.url.includes("ifLVGL=1"));
      files.set(uri, bytes);
      request.success({ ...response, data: uri });
      return uri;
    },
    fail(request, code = 28) { request.pending = false; request.fail("injected network error", code); },
    books() { return JSON.parse(files.get("internal://files/comics.json") || "[]"); },
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await tick();
      }
      clock = target;
      await tick();
    },
  };
  return h;
}

async function loadList(h, page, id = "A", count = 2) {
  const task = page.fetchImageList();
  h.list(h.requests.at(-1), id, count);
  await task;
}

test("P1-43 target ownership blocks deletion until an exited download's native move settles", async () => {
  const h = harness();
  const page = await h.mount({ total_chapters: 1 });
  h.list(h.requests[0], "A", 1); await tick();
  h.hold("move", (options) => options.dstUri.endsWith("/source_A/1"));
  h.image(h.requests[1], "page"); await tick();
  page.cancelDownload(); await tick();
  assert.equal(h.global.$storage.acquireComicMutation("source_A"), null);
  await h.finish("move");
  const lease = h.global.$storage.acquireComicMutation("source_A");
  assert.ok(lease, "ownership releases only after the native write really finishes");
  lease.release();
});

test("HTTP task uses download page and preserves sparse chapter metadata before reporting completion", async () => {
  const h = harness();
  const ctx = { localId: "local_task_test", endpoint: "http://host:1234", totalPages: 1,
    source: { apiUrl: "http://host:1234", photoPath: "/chapters/<id>/<chapter>" },
    detail: { name: "Imported", page_count: 1, total_chapters: 5, cover: "" },
    task: { comicId: "book_test", name: "Imported", chapters: [{ chapterNum: 5, pageCount: 1 }], imageProfile: {} } };
  const results = [];
  h.global.$gateway = {
    getDownloadContext: () => ctx,
    requestDownload: (_ctx, options) => h.global.$api.apiFetch(options),
    pageSaved() {},
    async commitDownload() {
      const book = h.books().find((b) => b.id === ctx.localId);
      assert.equal(book.chapters[0].num, 5);
      assert.equal(book.chapters[0].page_count, 1);
      assert.equal(book.chapters[0].downloaded, 1);
    },
    finishDownload: (_ctx, success) => results.push(success),
  };
  const page = await h.mount({ gatewayTaskId: "test" });
  assert.equal(page.showChapterSelect, false);
  assert.equal(h.requests[0].url, "http://host:1234/chapters/book_test/5");
  h.list(h.requests[0], "chapter", 1, "第五/章");
  await tick();
  h.image(h.requests[1], "page");
  await tick();
  await h.advance(500);
  assert.deepEqual(results, [true]);
  assert.ok(h.files.has("internal://files/local_task_test/5　第五_章/1"));
});

for (const [format, usePng, useBin] of [["JPEG", false, false], ["PNG", true, false], ["LVGL", true, true]]) {
test(`HTTP download page uses standard source and shared move path for cover and four ${format} pages`, async () => {
  // Device settings differ from the frozen task profile; the task must win.
  const h = harness();
  const endpoint = "http://host:1234";
  const ctx = { taskId: "task_cover", localId: "local_task_cover", endpoint, totalPages: 4,
    source: { apiUrl: endpoint, photoPath: "/custom/<id>/list/<chapter>" },
    detail: { name: "Cover test", page_count: 4, total_chapters: 1, cover: endpoint + "/selected/cover" },
    task: { comicId: "book_cover", name: "Wrong task name", coverUrl: endpoint + "/last-page",
      chapters: [{ chapterNum: 1, pageCount: 4 }], imageProfile: { width: 360, quality: 60, ifPng: usePng, ifLvgl: useBin } } };
  const adapter = vm.createContext({
    global: h.global,
    gatewayFetch: (params) => h.global.$api.apiFetch(params),
    console: { info: noop },
  });
  vm.runInContext(read("../src/components/gatewaySession.js")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), adapter);
  const results = [];
  h.global.$gateway = {
    getDownloadContext: () => ctx,
    requestDownload: adapter.requestDownload,
    pageSaved() {},
    async commitDownload() {},
    finishDownload: (_ctx, success) => results.push(success),
  };
  const page = await h.mount({ gatewayTaskId: ctx.taskId });
  assert.equal(page.name, "Cover test");
  assert.equal(h.requests[0].url, endpoint + "/custom/book_cover/list/1");
  assert.equal(h.global.API_SETTING.using, "source");
  h.global.APP_SETTING.imageUsePng = !usePng;
  h.global.APP_SETTING.imagePreTranscode = !useBin;
  h.requests[0].success({ statusCode: 200, data: { title: "Chapter", images:
    Array.from({ length: 4 }, (_, i) => ({ url: endpoint + `/local/photo/book_cover/chapter/1/${i + 1}.jpg` }))
  } });
  await tick();
  const coverRequest = h.requests[1];
  const coverUrl = new URL(coverRequest.url);
  assert.equal(coverUrl.pathname, "/selected/cover");
  assert.equal(coverUrl.searchParams.get("ifLVGL"), null);
  assert.equal(coverUrl.searchParams.get("width"), "80");
  assert.equal(coverUrl.searchParams.get("quality"), "60");
  assert.equal(coverUrl.searchParams.get("ifPNG"), usePng ? "1" : null);
  assert.ok(!/\.(png|jpg|bin)$/.test(coverUrl.hash));
  const coverBytes = imageBytes("SELECTED_COVER");
  const coverTemp = "internal://files/" + coverUrl.hash.slice(2);
  h.image(coverRequest, coverBytes, coverTemp);
  await tick();
  const nativeNames = [coverTemp];
  for (let i = 1; i <= 4; i++) {
    const request = h.requests[i + 1];
    const url = new URL(request.url);
    assert.equal(url.searchParams.get("ifLVGL"), useBin ? "1" : null);
    assert.equal(url.searchParams.get("ifPNG"), usePng ? "1" : null);
    assert.equal(url.searchParams.get("width"), "360");
    assert.equal(url.hash.endsWith(".bin"), useBin);
    assert.ok(!/\.(png|jpg)$/.test(url.hash));
    const temp = "internal://files/" + url.hash.slice(2);
    nativeNames.push(temp);
    h.image(request, imageBytes("PAGE_" + i, useBin), temp);
    await tick();
  }
  assert.equal(new Set(nativeNames).size, 5);
  assert.deepEqual(h.files.get("internal://files/local_task_cover/cover"), coverBytes);
  for (let i = 1; i <= 4; i++) {
    const uri = `internal://files/local_task_cover/${i}${useBin ? ".bin" : ""}`;
    assert.deepEqual(h.files.get(uri), imageBytes("PAGE_" + i, useBin));
  }
  assert.equal(h.calls.filter((c) => c.type === "copy").length, 0);
  assert.equal(h.calls.filter((c) => c.type === "move" && nativeNames.includes(c.srcUri)).length, 5);
  assert.equal(h.books()[0].chapters[0].downloaded, 4, "cover is excluded from page counts");
  assert.equal([...h.files.keys()].some((uri) => uri.startsWith("internal://files/_icf_")), false);
  assert.deepEqual(results, [true]);
  page.onDestroy();
});
}

for (const moveFailure of [false, true]) {
test(`HTTP shared move ${moveFailure ? "failure" : "late completion after exit"} cleans only its own temp`, async () => {
  const h = harness();
  const page = await h.mount();
  const state = page._downloadState;
  state.gateway = {};
  h.global.$gateway = { finishDownload() {} };
  const nativeUri = "internal://files/_icf_cover_test";
  h.files.set(nativeUri, imageBytes("COVER"));
  h.hold("move");
  const saving = outcome(page.saveDownloadedFile({ data: nativeUri, statusCode: 200 },
    "internal://files/source_A/cover", state, false));
  await tick();
  if (moveFailure) {
    await h.finish("move", 300);
    assert.ok(await saving);
    assert.equal(h.files.has("internal://files/source_A/cover"), false);
  } else {
    page.onDestroy();
    isAborted(await saving);
    await h.finish("move");
    assert.deepEqual(h.files.get("internal://files/source_A/cover"), imageBytes("COVER"));
  }
  assert.equal(h.files.has(nativeUri), false);
  assert.equal(h.requests.length, 0);
});
}

for (const cancellable of [false, true]) {
  for (const oldFirst of [false, true]) {
    test(`list race: cancel=${cancellable}, oldFirst=${oldFirst}; B stores only B pages`, async () => {
      const h = harness({ cancellable });
      const a = await h.mount({ total_chapters: 1 });
      a.onDestroy();
      const b = await h.mount({ id: "B", name: "Book B", total_chapters: 1 });
      const replyOld = async () => {
        const before = h.calls.length;
        h.list(h.requests[0], "A");
        await tick();
        assert.equal(h.calls.length, before, "old list must not start IO");
        assert.equal(a.chapterName, "");
      };
      if (oldFirst) await replyOld();
      h.list(h.requests[1], "B");
      await tick();
      if (!oldFirst) await replyOld();
      assert.equal(new URL(h.requests[2].url).pathname, "/B/1");
      h.image(h.requests[2], "B_PAGE_1");
      await tick();
      assert.equal(new URL(h.requests[3].url).pathname, "/B/2");
      h.image(h.requests[3], "B_PAGE_2");
      await tick();
      assert.deepEqual(h.files.get("internal://files/source_B/2"), imageBytes("B_PAGE_2"));
      assert.equal(h.books().find((book) => book.id === "source_A").chapters, undefined);
      assert.equal(h.books().find((book) => book.id === "source_B").chapters[0].page_count, 2);
      assert.equal(a.downloadError, "");
      assert.equal(h.requests[0].cancelCount, cancellable ? 1 : 0);
      assert.equal(b._downloadState.pending.length, 1, "only completion delay remains");
      await h.advance(1000);
      assert.equal(h.routes.length, 1);
      assert.equal(b._downloadState.pending.length, 0);
    });
  }
}

for (const oldFirst of [false, true]) {
  test(`image race: oldFirst=${oldFirst}; late A temp is deleted without affecting B`, async () => {
    const h = harness();
    const a = await h.mount({ total_chapters: 1 });
    h.list(h.requests[0], "A", 1);
    await tick();
    const oldImage = h.requests[1];
    a.onDestroy();
    const b = await h.mount({ id: "B", total_chapters: 1 });
    h.list(h.requests[2], "B", 1);
    await tick();
    const newImage = h.requests[3];
    let oldTemp;
    const replyOld = async () => { oldTemp = h.image(oldImage, "A_IMAGE"); await tick(); };
    if (oldFirst) await replyOld();
    h.image(newImage, "B_IMAGE");
    await tick();
    if (!oldFirst) await replyOld();
    assert.ok(h.deleted.includes(oldTemp));
    assert.equal(h.files.has("internal://files/source_A/1"), false);
    assert.deepEqual(h.files.get("internal://files/source_B/1"), imageBytes("B_IMAGE"));
    assert.equal(a.page, 0);
    assert.equal(b.page, 1);
    b.onDestroy();
    await h.advance(2000);
    assert.equal(h.routes.length, 0);
  });
}

test("late A cover cannot mark B's cover done or skip B's cover request", async () => {
  const h = harness({ cancellable: true });
  const a = await h.mount({ total_chapters: 1, cover: "https://images.test/A_cover" });
  h.list(h.requests[0], "A", 1);
  await tick();
  const oldCover = h.requests[1];
  a.onDestroy();
  const b = await h.mount({ id: "B", total_chapters: 1, cover: "https://images.test/B_cover" });
  h.list(h.requests[2], "B", 1);
  await tick();
  const newCover = h.requests[3];
  const before = h.calls.length;
  const oldTemp = h.image(oldCover, "OLD_COVER");
  await tick();
  assert.equal(oldCover.cancelCount, 1);
  assert.equal(b._downloadState.coverDone, false);
  assert.equal(h.calls.length, before);
  assert.ok(h.deleted.includes(oldTemp));
  assert.equal(new URL(newCover.url).pathname, "/B_cover");
  h.image(newCover, "B_COVER");
  await tick();
  assert.equal(b._downloadState.coverDone, true);
  h.image(h.requests[4], "B_PAGE_1");
  await tick();
  assert.deepEqual(h.files.get("internal://files/source_B/cover"), imageBytes("B_COVER"));
  assert.equal(h.books().find((book) => book.id === "source_B").chapters[0].downloaded, 1);
  b.onDestroy();
});

for (const kind of ["page", "cover"]) {
  for (const probeSuccess of [false, true]) {
    test(`late ${kind} access callback: success=${probeSuccess}; no fetch or move after exit`, async () => {
      const h = harness();
      const page = await h.mount({ cover: "https://images.test/cover" });
      await loadList(h, page);
      h.hold("access");
      const task = outcome(kind === "page"
        ? page.downloadPage(1, "internal://files/source_A")
        : page.downloadCover("internal://files/source_A"));
      if (probeSuccess) h.files.set(h.pending[0].options.uri, "EXISTING");
      page.routeBack();
      isAborted(await task);
      await h.finish("access");
      assert.equal(h.requests.length, 1);
      assert.equal(h.calls.some((call) => call.type === "move"), false);
      assert.equal(page._downloadState.pending.length, 0);
    });
  }
}

for (const kind of ["list", "page", "cover"]) {
  test(`${kind} retry delay is cancelled; even a stale timer cannot revive the old request`, async () => {
    const h = harness();
    const page = await h.mount({ cover: "https://images.test/cover" });
    if (kind !== "list") await loadList(h, page);
    const task = outcome(kind === "list" ? page.fetchImageList()
      : kind === "page" ? page.downloadPage(1, "internal://files/source_A")
        : page.downloadCover("internal://files/source_A"));
    await tick();
    h.fail(h.requests.at(-1));
    await tick();
    const staleTimer = [...h.timers.values()][0];
    assert.ok(staleTimer);
    const count = h.requests.length;
    page.onDestroy();
    isAborted(await task);
    assert.equal(h.timers.size, 0);
    staleTimer.fn();
    await h.advance(2000);
    assert.equal(h.requests.length, count);
    assert.equal(page._downloadState.pending.length, 0);
  });
}

for (const kind of ["page", "cover"]) {
  test(`${kind} response resolves just before exit; its await continuation cleans temp instead of moving`, async () => {
    const h = harness();
    const page = await h.mount({ cover: "https://images.test/cover" });
    await loadList(h, page);
    const task = outcome(kind === "page" ? page.downloadPage(1, "internal://files/source_A")
      : page.downloadCover("internal://files/source_A"));
    await tick();
    const temp = h.image(h.requests.at(-1), "LATE");
    page.onDestroy();
    isAborted(await task);
    assert.ok(h.deleted.includes(temp));
    assert.equal(h.calls.some((call) => call.type === "move"), false);
  });
}

test("cleanup ignores formal files and cleans only the stale request's own _icf_ temp", async () => {
  const h = harness();
  const page = await h.mount();
  await loadList(h, page);
  const task = outcome(page.downloadPage(1, "internal://files/source_A"));
  await tick();
  const other = "internal://files/_icf_other_owner";
  h.files.set(other, "OTHER");
  page.onDestroy();
  isAborted(await task);
  const formal = h.image(h.requests.at(-1), "FORMAL", "internal://files/source_B/1");
  await tick();
  assert.equal(h.deleted.length, 0);
  assert.deepEqual(h.files.get(formal), imageBytes("FORMAL"));
  assert.equal(h.files.get(other), "OTHER");
});

for (const moveError of [undefined, 300]) {
  test(`move already submitted before exit: error=${moveError}; no progress or follow-up IO`, async () => {
    const h = harness();
    const page = await h.mount({ total_chapters: 1 });
    h.list(h.requests[0], "A");
    await tick();
    h.hold("move", (options) => options.dstUri.endsWith("/1"));
    const temp = h.image(h.requests[1], "PAGE_1");
    await tick();
    assert.equal(h.pending.length, 1);
    const before = h.calls.length;
    page.onDestroy();
    await h.finish("move", moveError);
    assert.equal(h.calls.length, before);
    assert.equal(h.requests.length, 2);
    assert.equal(page.page, 0);
    assert.equal(h.toasts.length, 0);
    assert.equal(h.routes.length, 0);
    if (moveError) assert.ok(h.deleted.includes(temp));
    else assert.deepEqual(h.files.get("internal://files/source_A/1"), imageBytes("PAGE_1"));
  });
}

test("late mkdir completion cannot start cover or page requests", async () => {
  const h = harness();
  const page = await h.mount({ total_chapters: 1, cover: "https://images.test/cover" });
  h.hold("mkdir");
  h.list(h.requests[0], "A");
  await tick();
  assert.equal(h.pending.length, 1);
  const before = h.calls.length;
  page.onDestroy();
  await h.finish("mkdir");
  assert.equal(h.calls.length, before);
  assert.equal(h.requests.length, 1);
  assert.equal(page.downloadError, "");
});

test("late final scan cannot enqueue a metadata update", async () => {
  const h = harness();
  const page = await h.mount();
  h.dirs.add("internal://files/source_A");
  h.hold("get");
  const task = outcome(page.syncComicStorageMeta(page._downloadState));
  page.onDestroy();
  isAborted(await task);
  const before = h.calls.length;
  await h.finish("get");
  assert.equal(h.calls.length, before);
  assert.equal(h.files.has("internal://files/comics.json"), false);
});

for (const kind of ["register", "chapter", "scan"]) {
  test(`real storage queue: ${kind} updater delayed until after exit never writes metadata`, async () => {
    const h = harness();
    const page = await h.mount();
    h.dirs.add("internal://files/source_A");
    h.hold("readText");
    const task = outcome(kind === "register" ? page.ensureComicRegistered(page._downloadState)
      : kind === "chapter" ? page.syncChapterMeta(page._downloadState)
        : page.syncComicStorageMeta(page._downloadState));
    await tick();
    assert.equal(h.pending.length, 1);
    page.onDestroy();
    await h.finish("readText");
    isAborted(await task);
    assert.equal(h.calls.some((call) => call.type === "writeText"), false);
    assert.equal(h.books().length, 0);
  });
}

test("metadata write already submitted before exit may complete but cannot start the list request", async () => {
  const h = harness();
  h.hold("writeText");
  const page = await h.mount({ total_chapters: 1 });
  assert.equal(h.pending.length, 1);
  page.onDestroy();
  await h.finish("writeText");
  assert.equal(h.requests.length, 0);
  assert.equal(h.calls.filter((call) => call.type === "writeText").length, 1);
  assert.equal(h.books()[0].id, "source_A");
  assert.equal(h.toasts.length, 0);
});

test("exit during onInit prevents its continuation from registering a comic", async () => {
  const h = harness();
  const page = h.instance({ total_chapters: 1 });
  const init = page.onInit();
  assert.equal(page.onBackPress(), false);
  await init;
  assert.equal(h.requests.length, 0);
  assert.equal(h.calls.length, 0);
});

test("destroying A after B has loaded cannot clear B's images or serial queue state", async () => {
  const h = harness();
  const a = await h.mount();
  const b = await h.mount({ id: "B", name: "Book B" });
  await loadList(h, b, "B");
  b._downloadState.failedChapters.push(2);
  b._downloadState.coverDone = true;
  a.onDestroy();
  assert.equal(b._downloadState.failedChapters[0], 2);
  assert.equal(b._downloadState.coverDone, true);
  const task = b.downloadPage(1, "internal://files/source_B");
  await tick();
  assert.equal(new URL(h.requests[1].url).pathname, "/B/1");
  h.image(h.requests[1], "B_ONLY");
  await task;
  assert.deepEqual(h.files.get("internal://files/source_B/1"), imageBytes("B_ONLY"));
});

test("same instance reinitialization rejects the previous task by state identity", async () => {
  const h = harness();
  const page = await h.mount();
  const oldTask = outcome(page.fetchImageList());
  page.id = "B";
  page.name = "Book B";
  await page.onInit();
  const newTask = page.fetchImageList();
  h.list(h.requests[1], "B", 1);
  await newTask;
  h.list(h.requests[0], "A", 4);
  await tick();
  isAborted(await oldTask);
  assert.equal(page.page_count, 1);
  assert.equal(page.chapterName, "B");
  assert.equal(page._downloadState.imageCache[0], "https://images.test/B/1");
});

test("serial bin download remains ordered, skips existing pages and downloads cover only once", async () => {
  const h = harness({ bin: true });
  const root = "internal://files/source_A";
  const chapter1 = root + "/1　Chapter 1";
  h.dirs.add(root);
  h.dirs.add(chapter1);
  h.files.set(chapter1 + "/1.bin", imageBytes("EXISTING_1", true));
  const page = await h.mount({ cover: "https://images.test/cover" });
  page.selectedChapters = [1, 2];
  const batch = page.startBatchDownload();
  await page.startBatchDownload(); // Hidden selection UI cannot start a second chain.
  await tick();
  assert.equal(h.requests.length, 1);
  h.list(h.requests[0], "C1", 2, "Chapter 1");
  await tick();
  assert.equal(new URL(h.requests[1].url).pathname, "/cover");
  assert.equal(new URL(h.requests[1].url).searchParams.get("ifLVGL"), null);
  h.image(h.requests[1], "COVER");
  await tick();
  assert.equal(new URL(h.requests[2].url).pathname, "/C1/2");
  assert.equal(new URL(h.requests[2].url).searchParams.get("ifLVGL"), "1");
  h.image(h.requests[2], "C1_PAGE_2");
  await tick();
  assert.equal(h.requests.length, 3);
  await h.advance(500);
  assert.equal(new URL(h.requests[3].url).pathname, "/photo/A/2");
  h.list(h.requests[3], "C2", 2, "Chapter 2");
  await tick();
  h.image(h.requests[4], "C2_PAGE_1");
  await tick();
  assert.equal(new URL(h.requests[5].url).pathname, "/C2/2");
  h.image(h.requests[5], "C2_PAGE_2");
  await tick();
  await h.advance(1500);
  await batch;
  assert.equal(h.requests.length, 6);
  assert.deepEqual(h.files.get(chapter1 + "/1.bin"), imageBytes("EXISTING_1", true));
  assert.deepEqual(h.files.get(chapter1 + "/2.bin"), imageBytes("C1_PAGE_2", true));
  assert.deepEqual(h.files.get(root + "/2　Chapter 2/2.bin"), imageBytes("C2_PAGE_2", true));
  assert.deepEqual(h.files.get(root + "/cover"), imageBytes("COVER"));
  assert.equal(h.books()[0].name, "Book A");
  assert.deepEqual(h.books()[0].chapters.map((chapter) => chapter.downloaded), [2, 2]);
  assert.equal(h.routes.length, 1);
  assert.equal(page._downloadState.pending.length, 0);

  const resume = await h.mount({ cover: "https://images.test/cover" });
  resume.selectedChapters = [1, 2];
  const resumed = resume.startBatchDownload();
  await tick();
  h.list(h.requests[6], "C1", 2, "Chapter 1");
  await tick();
  await h.advance(500);
  h.list(h.requests[7], "C2", 2, "Chapter 2");
  await tick();
  await h.advance(1500);
  await resumed;
  assert.equal(h.requests.length, 8, "resume fetches chapter lists but no cover or page images");
});

test("failed page retries retain their quota and one serial supplemental attempt", async () => {
  const h = harness();
  const page = await h.mount();
  await loadList(h, page);
  const task = outcome(page.downloadPages("internal://files/source_A"));
  await tick();
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(new URL(h.requests.at(-1).url).pathname, "/A/1");
    h.fail(h.requests.at(-1));
    await tick();
    if (attempt < 3) await h.advance(1000);
  }
  assert.equal(new URL(h.requests.at(-1).url).pathname, "/A/2");
  h.image(h.requests.at(-1), "PAGE_2");
  await tick();
  assert.equal(new URL(h.requests.at(-1).url).pathname, "/A/1");
  h.fail(h.requests.at(-1));
  const error = await task;
  assert.match(error, /download\.downloadTimeoutFailed/);
  assert.equal(h.requests.length, 7, "one list, four page-1 attempts, page 2, one supplement");
  assert.equal(h.toasts.length, 2, "one network retry toast and one supplemental retry toast");
  assert.equal(page.page, 1);
  assert.equal(page._downloadState.pending.length, 0);
});

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} is rejected without saving; fast-fails without retries`, async () => {
    const h = harness();
    const page = await h.mount();
    await loadList(h, page);
    const task = outcome(page.downloadPage(1, "internal://files/source_A"));
    await tick();
    const temp = `internal://files/_icf_bad_${status}`;
    h.image(h.requests.at(-1), Buffer.from("<html>error</html>"), temp, { statusCode: status });
    const error = await task;
    assert.match(error, /download\.downloadFailed/);
    assert.equal(h.calls.some((call) => call.type === "move"), false);
    assert.ok(h.deleted.includes(temp));
    assert.equal(h.requests.length, 2, "deterministic 4xx fast-fails without 3 retries");
  });
}

test("HTTP 500 retries using its quota and fails after exhaustion without saving", async () => {
  const h = harness();
  const page = await h.mount();
  await loadList(h, page);
  const task = outcome(page.downloadPage(1, "internal://files/source_A"));
  await tick();
  for (let attempt = 0; attempt < 4; attempt++) {
    const temp = `internal://files/_icf_500_${attempt}`;
    h.image(h.requests.at(-1), Buffer.from("<html>500 error</html>"), temp, { statusCode: 500 });
    await tick();
    assert.ok(h.deleted.includes(temp));
    if (attempt < 3) await h.advance(1000);
  }
  const error = await task;
  assert.match(error, /download\.downloadFailed500/);
  assert.equal(h.calls.some((call) => call.type === "move"), false);
  assert.equal(h.requests.length, 5);
});

test("200 HTML login/error body is rejected as an invalid image and cleans the temp file", async () => {
  const h = harness();
  const page = await h.mount();
  await loadList(h, page);
  const task = outcome(page.downloadPage(1, "internal://files/source_A"));
  await tick();
  const temp = "internal://files/_icf_login";
  h.image(h.requests.at(-1), Buffer.from("<html>login required</html>"), temp, { statusCode: 200 });
  const error = await task;
  assert.match(error, /error\.invalidResponse/);
  assert.equal(h.calls.some((call) => call.type === "move"), false);
  assert.ok(h.deleted.includes(temp));
});

test("corrupt existing image on disk is detected and re-downloaded with fresh content", async () => {
  const h = harness();
  const root = "internal://files/source_A";
  h.dirs.add(root);
  h.files.set(root + "/1", Buffer.from("<html>stale 404 error</html>"));
  const page = await h.mount();
  await loadList(h, page);
  const task = page.downloadPage(1, root);
  await tick();
  assert.equal(h.requests.length, 2, "corrupt file triggers a download request");
  h.image(h.requests.at(-1), "REPAIRED");
  await task;
  assert.deepEqual(h.files.get(root + "/1"), imageBytes("REPAIRED"));
});

test("existing valid image with read failure is preserved rather than overwritten or deleted", async () => {
  const h = harness();
  const root = "internal://files/source_A";
  h.dirs.add(root);
  h.files.set(root + "/1", imageBytes("VALID"));
  const page = await h.mount();
  await loadList(h, page);
  h.hold("readArrayBuffer");
  const task = outcome(page.downloadPage(1, root));
  await tick();
  assert.equal(h.pending.length, 1);
  await h.finish("readArrayBuffer", 300);
  const error = await task;
  assert.match(error, /download\.downloadFailed300/);
  assert.deepEqual(h.files.get(root + "/1"), imageBytes("VALID"));
  assert.equal(h.calls.some((call) => call.type === "move"), false);
  assert.equal(h.requests.length, 1);
});

test("download: special characters in chapter title sanitize metadata name consistently with directory URI (P1-31)", async () => {
  const h = harness();
  const root = "internal://files/source_A";
  const specialTitle = "Chapter 1: Part A/B?*";
  const expectedSanitized = "Chapter 1_ Part A_B__";

  const page = await h.mount({
    total_chapters: 2,
    cover: "https://images.test/cover",
  });
  page.selectedChapters = [1];
  const batch = page.startBatchDownload();
  await tick();

  // 返回包含特殊字符的章节名
  h.list(h.requests[0], "C1", 2, specialTitle);
  await tick();

  // 接收封面与正文并推进到完成
  h.image(h.requests[1], "COVER");
  await tick();
  h.image(h.requests[2], "PAGE_1");
  await tick();
  h.image(h.requests[3], "PAGE_2");
  await tick();
  await h.advance(1500);
  await batch;

  // 验证元数据中的章节名已被规范化，且与目录一致
  const completedBooks = h.books();
  assert.equal(completedBooks.length, 1);
  const chapterEntry = completedBooks[0].chapters[0];
  assert.equal(chapterEntry.num, 1);
  assert.equal(chapterEntry.name, expectedSanitized, "元数据登记的章节名必须与规范化目录一致");

  // 验证建成的目录名
  const expectedDir = `${root}/1　${expectedSanitized}`;
  assert.ok(h.dirs.has(expectedDir), "创建的磁盘物理目录必须为规范化后的名称");
  assert.deepEqual(h.files.get(`${expectedDir}/1`), imageBytes("PAGE_1"));
});

test("photo: local serial reading resolves images for special-character chapter even with un-sanitized old metadata (P1-31)", async () => {
  const photoSource = read("../src/pages/photo/photo.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
  const routeSource = read("../src/components/routerParams.js");
  const files = new Map();
  const comicId = "local_comic_special";
  const expectedSanitized = "Chapter 1_ Part A_B__";
  const onDiskDir = `internal://files/${comicId}/1　${expectedSanitized}`;
  files.set(`${onDiskDir}/1`, imageBytes("IMAGE_P1"));

  const fileMock = {
    access(options) {
      if (files.has(options.uri)) options.success();
      else options.fail("not found", 301);
    },
  };

  const appGlobal = {
    $img: { addImageParams: (u) => u, appendLvglSuffix: (u) => u },
    $route: {},
    $storage: {
      readHistory: () => Promise.resolve([]),
      updateJsonFile: () => Promise.resolve(),
      HISTORY_URI: "internal://files/history.json",
      sanitizeFolderName: (name) => name ? name.replace(/[\\/:*?"<>|]/g, "_") : name,
    },
    $api: {
      apiFetch: () => {},
      buildPhotoUrl: () => "",
    },
    screenSize: { width: 480, height: 480 },
    getTime: () => "12:00",
    APP_SETTING: { imageSize: "480", imageQuality: "50" },
  };

  const routeContext = vm.createContext({ global: appGlobal });
  vm.runInContext(routeSource.replace(/^export /gm, "") + "\nglobal.$route.parseParam = parseParam;", routeContext);

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: () => {}, error: () => {} },
    file: fileMock,
    Promise,
    URL,
  });

  vm.runInContext(photoSource.replace(/^import .*;\r?\n/gm, "").replace("export default ", "globalThis.photoDef = "), context);

  const photoInstance = Object.assign({}, context.photoDef, clone(context.photoDef.private), {
    id: comicId,
    local: true,
    is_serial: true,
    chapter: 1,
    page: 1,
    page_count: 2,
    total_chapters: 1,
    // 模拟旧版本留下的未规范化元数据名称（包含冒号、斜杠、星号等）
    downloadChapter: [["Chapter 1: Part A/B?*", 2, 1]],
    isImageRequestCurrent: () => true,
    enterErrorState: () => { photoInstance.images = "ERROR"; },
  });

  // 触发获取当前页图片
  photoInstance.getImageForPage();

  // 验证：成功命中磁盘上已规范化的实际物理路径！
  assert.equal(photoInstance.images, `${onDiskDir}/1`, "通过规范化路径自动成功解析图片");
});

test("photo: sparse download, supplemental previous chapters, and history resume chapter correctly (P1-32)", async () => {
  const photoSource = read("../src/pages/photo/photo.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
  const routeSource = read("../src/components/routerParams.js");
  const comicId = "sparse_comic";

  // 场景：稀疏下载了第 2 章和第 5 章
  // 此时 totalChapter 格式为：[[名称, 页数, 真实章号]]
  // downloadChapter 数组为：[["Chapter 2", 10, 2], ["Chapter 5", 20, 5]]
  const sparseDownloadChapter = [
    ["Chapter 2", 10, 2],
    ["Chapter 5", 20, 5],
  ];

  let savedHistory = [];
  const appGlobal = {
    $img: { addImageParams: (u) => u, appendLvglSuffix: (u) => u },
    $route: {},
    $storage: {
      readHistory: () => Promise.resolve(savedHistory),
      updateJsonFile: (uri, fallback, fn) => {
        savedHistory = fn(savedHistory);
        return Promise.resolve(savedHistory);
      },
      HISTORY_URI: "internal://files/history.json",
      sanitizeFolderName: (name) => name,
    },
    $api: { apiFetch: () => {}, buildPhotoUrl: () => "" },
    screenSize: { width: 480, height: 480 },
    getTime: () => "12:00",
    APP_SETTING: { imageSize: "480", imageQuality: "50" },
  };

  const routeContext = vm.createContext({ global: appGlobal });
  vm.runInContext(routeSource.replace(/^export /gm, "") + "\nglobal.$route.parseParam = parseParam;", routeContext);

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: () => {}, error: () => {} },
    file: { access: (opts) => opts.success() },
    Promise,
    URL,
  });

  vm.runInContext(photoSource.replace(/^import .*;\r?\n/gm, "").replace("export default ", "globalThis.photoDef = "), context);

  // 1. 用户打开该漫画，阅读第 5 章（在稀疏列表中为下标 2，即 chapter=2）
  const photo1 = Object.assign({}, context.photoDef, clone(context.photoDef.private), {
    id: comicId,
    local: true,
    is_serial: true,
    chapter: 2, // 对应 downloadChapter[1] 即第 5 章
    page: 7,
    page_count: 20,
    downloadChapter: sparseDownloadChapter,
    $element: () => ({ scrollTo: () => {} }),
    $t: (k) => k,
  });

  const historyData = photo1.buildHistoryData();
  // 必须记录真实章号 5，而不是数组下标 2
  assert.equal(historyData.chapter, 5, "历史记录保存的必须是真实章号 5");
  assert.equal(historyData.chapterNum, 5);
  assert.equal(historyData.page, 7);

  // 2. 模拟用户退回书架，后来补下载了第 1 章！
  // 现在的章节列表变为第 1、2、5 章
  const updatedDownloadChapter = [
    ["Chapter 1", 15, 1],
    ["Chapter 2", 10, 2],
    ["Chapter 5", 20, 5],
  ];

  savedHistory = [historyData];

  // 3. 用户再次打开漫画，恢复阅读位置
  const photo2 = Object.assign({}, context.photoDef, clone(context.photoDef.private), {
    id: comicId,
    local: true,
    is_serial: true,
    downloadChapter: updatedDownloadChapter,
    $element: () => ({ scrollTo: () => {} }),
    $t: (k) => k,
  });

  await photo2.onInit();
  await tick();

  // 验证：尽管列表前方插入了第 1 章，恢复阅读位置后依然准确对准第 5 章（即当前列表中的第 3 个位置）！
  assert.equal(photo2.chapter, 3, "当前列表下标正确映射为第 3 项");
  assert.equal(photo2.downloadChapter[photo2.chapter - 1][2], 5, "打开的依然是真实第 5 章");
  assert.equal(photo2.page, 7, "页码依然是第 7 页");
});

test("photo: chapter deletion fallback and legacy index-based history compatibility (P1-32)", async () => {
  const photoSource = read("../src/pages/photo/photo.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
  const routeSource = read("../src/components/routerParams.js");
  const comicId = "fallback_comic";

  let savedHistory = [];
  const appGlobal = {
    $img: { addImageParams: (u) => u, appendLvglSuffix: (u) => u },
    $route: {},
    $storage: {
      readHistory: () => Promise.resolve(savedHistory),
      updateJsonFile: (uri, fallback, fn) => {
        savedHistory = fn(savedHistory);
        return Promise.resolve(savedHistory);
      },
      HISTORY_URI: "internal://files/history.json",
      sanitizeFolderName: (name) => name,
    },
    $api: { apiFetch: () => {}, buildPhotoUrl: () => "" },
    screenSize: { width: 480, height: 480 },
    getTime: () => "12:00",
    APP_SETTING: { imageSize: "480", imageQuality: "50" },
  };

  const routeContext = vm.createContext({ global: appGlobal });
  vm.runInContext(routeSource.replace(/^export /gm, "") + "\nglobal.$route.parseParam = parseParam;", routeContext);

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: () => {}, error: () => {} },
    file: { access: (opts) => opts.success() },
    Promise,
    URL,
  });

  vm.runInContext(photoSource.replace(/^import .*;\r?\n/gm, "").replace("export default ", "globalThis.photoDef = "), context);

  // 1. 测试旧版历史格式（无 chapterNum，只有 chapter: 2 表示原列表第 2 项）
  savedHistory = [
    {
      id: "local_" + comicId,
      originalId: comicId,
      chapter: 2,
      page: 3,
    },
  ];

  const currentChapters = [
    ["Chapter 1", 10, 1],
    ["Chapter 2", 15, 2],
  ];

  const legacyPhoto = Object.assign({}, context.photoDef, clone(context.photoDef.private), {
    id: comicId,
    local: true,
    is_serial: true,
    downloadChapter: currentChapters,
    $element: () => ({ scrollTo: () => {} }),
    $t: (k) => k,
  });

  await legacyPhoto.onInit();
  await tick();

  // 校验：旧历史兼容回退到列表第 2 项
  assert.equal(legacyPhoto.chapter, 2);
  assert.equal(legacyPhoto.page, 3);

  // 2. 测试章节被删除场景（上次读第 5 章，但本地删除了第 5 章，只剩第 1、2 章）
  savedHistory = [
    {
      id: "local_" + comicId,
      originalId: comicId,
      chapter: 5,
      chapterNum: 5,
      page: 12,
    },
  ];

  const deletedPhoto = Object.assign({}, context.photoDef, clone(context.photoDef.private), {
    id: comicId,
    local: true,
    is_serial: true,
    downloadChapter: currentChapters, // 只有章号 1 和 2
    $element: () => ({ scrollTo: () => {} }),
    $t: (k) => k,
  });

  await deletedPhoto.onInit();
  await tick();

  // 校验：目标第 5 章被删除时，优雅回退至当前最大的可用章（第 2 项，即章号 2）
  assert.equal(deletedPhoto.chapter, 2);
  assert.equal(deletedPhoto.downloadChapter[deletedPhoto.chapter - 1][2], 2);
});

test("download: single comic storage meta counts only valid page files, ignores cover and extra files (P1-33)", async () => {
  const h = harness();
  const page = await h.mount({ total_chapters: 1, page_count: 3 });
  const comicId = page._downloadState.comicId;
  const folder = `internal://files/${comicId}`;
  h.dirs.add(folder);

  // 1. 无封面场景（仅正文 1, 2, 3）：应准确统计为 3 页，不扣减
  h.files.set(`${folder}/1`, "page1");
  h.files.set(`${folder}/2`, "page2");
  h.files.set(`${folder}/3`, "page3");

  await page.syncChapterMeta(page._downloadState);
  await page.syncComicStorageMeta(page._downloadState);

  let book = h.books().find((b) => b.id === comicId);
  assert.equal(book.chapters[0].downloaded, 3, "无封面时 3 张正文应登记 downloaded=3 而非 2");
  assert.equal(book.chapters[0].page_count, 3);

  // 2. 有封面场景（cover + 1, 2, 3）：排除 cover，依然统计为 3 页
  h.files.set(`${folder}/cover`, "cover_image");
  await page.syncComicStorageMeta(page._downloadState);
  book = h.books().find((b) => b.id === comicId);
  assert.equal(book.chapters[0].downloaded, 3, "有封面时排除 cover，正文页数依然为 3");

  // 3. 混入 bin 文件、临时文件及无关文件场景
  h.files.delete(`${folder}/1`);
  h.files.delete(`${folder}/2`);
  h.files.delete(`${folder}/3`);
  h.files.set(`${folder}/1.bin`, "bin1");
  h.files.set(`${folder}/2.bin`, "bin2");
  h.files.set(`${folder}/3.bin`, "bin3");
  h.files.set(`${folder}/download.tmp`, "temp_data");
  h.files.set(`${folder}/.DS_Store`, "noise");
  h.files.set(`${folder}/_icf_123.bin`, "orphan_temp");

  await page.syncComicStorageMeta(page._downloadState);
  book = h.books().find((b) => b.id === comicId);
  assert.equal(book.chapters[0].downloaded, 3, "支持 .bin 正文且自动过滤 tmp/.DS_Store 等无关文件");
});

test("offline: self-healing scan accurately counts valid pages without deducting cover and clears metaStale (P1-33)", async () => {
  const offlineSource = read("../src/pages/offline/offline.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
  const storageSource = read("../src/components/storage.js");

  const files = new Map();
  const dirs = new Set();
  function scan(uri) {
    const children = [];
    const prefix = uri + "/";
    for (const dir of dirs) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) {
        children.push({ uri: dir, type: "dir", subFiles: scan(dir) });
      }
    }
    for (const [path, content] of files) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
        children.push({ uri: path, type: "file", length: content.length });
      }
    }
    return children;
  }
  const file = {
    readText(options) {
      if (files.has(options.uri)) options.success({ text: files.get(options.uri) });
      else options.fail("missing", 301);
    },
    writeText(options) {
      files.set(options.uri, options.text);
      options.success();
    },
    get(options) {
      if (dirs.has(options.uri)) options.success({ type: "dir", subFiles: scan(options.uri) });
      else if (files.has(options.uri)) options.success({ type: "file", length: files.get(options.uri).length });
      else options.fail("missing", 301);
    },
    delete(options) {
      files.delete(options.uri);
      if (options.success) options.success();
    },
    move(options) {
      files.set(options.dstUri, files.get(options.srcUri));
      files.delete(options.srcUri);
      if (options.success) options.success();
    },
  };

  const quiet = { debug: noop, error: noop };
  const storageContext = vm.createContext({ file, console: quiet, Promise });
  vm.runInContext(
    storageSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") +
      "\nglobalThis.storage = { updateComicMeta, isAlreadyExistsError, readComics, sanitizeFolderName };",
    storageContext
  );

  const appGlobal = {
    $storage: storageContext.storage,
    $delete: { deleteComicById: noop },
    $route: { serializeParams: (p) => p },
    $img: { addCoverParams: (url) => url },
    $set: { getSearchPageSize: () => 10 },
    $cover: { loadCoverProxies: noop },
    createConfirmGuard: () => () => false,
    getTime: () => "12:00",
    getReservedSpace: () => 0,
  };

  const context = vm.createContext({
    global: appGlobal,
    console: quiet,
    file,
    Promise,
    router: { push: noop, replace: noop },
    prompt: { showToast: noop },
    device: {
      getTotalStorage: ({ success }) => success({ totalStorage: 1000000 }),
      getAvailableStorage: ({ success }) => success({ availableStorage: 800000 }),
    },
    setTimeout: (fn) => fn(),
  });

  vm.runInContext(
    offlineSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.offlineDef = "),
    context
  );

  const comicId = "single_test_comic";
  const folder = `internal://files/${comicId}`;
  dirs.add(folder);
  // 磁盘只有 3 张正文，无封面
  files.set(`${folder}/1`, "page1");
  files.set(`${folder}/2`, "page2");
  files.set(`${folder}/3`, "page3");

  // 元数据初始模拟此前有 bug 的情况：page_count=3, downloaded=2（被少算了1页），导致 metaStale=true
  const initialComics = [
    {
      id: comicId,
      name: "Single Test",
      page_count: 3,
      is_serial: false,
      size: 15,
      chapters: [{ num: 0, name: "", page_count: 3, downloaded: 2 }],
      downloaded_at: Date.now(),
    },
  ];
  files.set("internal://files/comics.json", JSON.stringify(initialComics));

  const offline = Object.assign({}, context.offlineDef, clone(context.offlineDef.private), {
    $t: (k) => k,
    $element: () => ({ scrollTo: () => {} }),
  });

  // 执行 loadingComic，会检测到 downloaded < page_count 并触发 metaStale 磁盘扫描自愈
  await offline.loadingComic();
  await tick();
  await tick();
  await tick();
  await tick();

  // 验证自愈后的 comics.json 元数据：downloaded 应已自愈为 3，不再是 2
  const updatedComics = JSON.parse(files.get("internal://files/comics.json"));
  assert.equal(updatedComics[0].chapters[0].downloaded, 3, "自愈后有效正文页数必须正确回写为 3");
  // 此时漫画已完全下载，isComicIncomplete 返回 false
  assert.equal(offline.isComicIncomplete(updatedComics[0]), false, "3/3 无封面漫画不得误标部分下载未完成");
});

test("search: cache trimming protects current display range across mismatched server/client page sizes (P1-34)", async () => {
  const searchSource = read("../src/pages/search/search.ux").match(/<script>([\s\S]*?)<\/script>/)[1];

  let clientPageSize = 10;
  const requests = [];

  const appGlobal = {
    APP_SETTING: {
      get searchPageSize() { return clientPageSize; },
      showCoverInSearch: false,
    },
    $img: { addCoverParams: (url) => url },
    $route: { serializeParams: (p) => p },
    $api: {
      buildSearchUrl: (text, page) => `https://test/search?q=${text}&page=${page}`,
      buildDetailUrl: (id) => `https://test/detail/${id}`,
      getFetchErrorType: () => "network",
      isComicDetailResponse: () => true,
      apiFetch(options) {
        requests.push(options);
      },
    },
    $set: {
      getSearchPageSize: () => clientPageSize,
    },
    $cover: {
      loadCoverProxies: () => () => {},
    },
    getTime: () => "12:00",
  };

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    Promise,
    router: { push: noop, replace: noop },
    prompt: { showToast: noop },
    setTimeout: (fn) => fn(),
  });

  vm.runInContext(
    searchSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.searchDef = "),
    context
  );

  function createSearch(params = {}) {
    return Object.assign({}, context.searchDef, clone(context.searchDef.private), {
      keyword: "test",
      $t: (k) => k,
      $element: () => ({ scrollTo: () => {} }),
      $nextTick: (fn) => fn(),
    }, params);
  }

  function mockServerPage(request, serverPage, itemsPerPage, hasMore = true) {
    const results = Array.from({ length: itemsPerPage }, (_, i) => ({
      comic_id: `comic_${serverPage}_${i + 1}`,
      title: `Item ${serverPage}-${i + 1}`,
      cover_url: `https://test/cover/${serverPage}/${i + 1}`,
    }));
    request.success({
      data: {
        page: serverPage,
        has_more: hasMore,
        results: results,
      },
    });
    if (request.complete) request.complete();
  }

  // 场景 1：复现 bug 报告中的核心场景——服务端 32 条/页，客户端 10 条/页。
  // 第 1 页拉取 serverPage 1 (32条，全局 0~31)
  // 翻到第 4 页（startIndex = 30），需要拉取 serverPage 2 (32条，全局 32~63)
  // 合并后 64 条 > MAX_CACHE(50)。
  // 原实现：直接丢弃前 32 条，apiDroppedCount 变为 32，第 4 页切片起点 rawStart = 30 - 32 = -2，导致切片为空！
  // 现实现：protectedStart = 30，下个 serverPage 起始点为 32 > 30，trimCache 必须受控停止丢弃，保留第 4 页所需的数据。
  clientPageSize = 10;
  requests.length = 0;
  const search1 = createSearch();
  search1.onInit();

  assert.equal(requests.length, 1);
  mockServerPage(requests.pop(), 1, 32, true);

  // 初始第 1 页
  assert.equal(search1.displayPage, 1);
  assert.equal(search1.searchResults.length, 10);
  assert.equal(search1.searchResults[0].gid, "comic_1_1");

  // 翻到第 4 页（显示 31~40 项，对应全局下标 30~39）
  search1.changeDisplayPage(4);
  assert.equal(search1.displayPage, 4);
  assert.equal(requests.length, 1, "触发拉取第 2 个服务端页");
  mockServerPage(requests.pop(), 2, 32, true);

  // 验证第 4 页数据切片非空，正确跨越 serverPage 1 的末尾 2 项和 serverPage 2 的起始 8 项！
  assert.equal(search1.searchResults.length, 10, "第 4 页展示必须完整为 10 条，不能变空");
  assert.equal(search1.searchResults[0].gid, "comic_1_31", "第 4 页第 1 项为 serverPage 1 的第 31 项");
  assert.equal(search1.searchResults[1].gid, "comic_1_32", "第 4 页第 2 项为 serverPage 1 的第 32 项");
  assert.equal(search1.searchResults[2].gid, "comic_2_1", "第 4 页第 3 项为 serverPage 2 的第 1 项");

  // 场景 2：继续向前翻页至第 7 页（下标 60~69），需要拉取 serverPage 3 (32条，全局 64~95)
  // 此时 protectedStart = 60，下个 serverPage 起始点为 32 <= 60，trimCache 正确淘汰 serverPage 1！
  // apiDroppedCount 变为 32，缓存内保留 serverPage 2 & 3（下标 32~95）
  search1.changeDisplayPage(7);
  assert.equal(search1.displayPage, 7);
  assert.equal(requests.length, 1, "翻到第 7 页触发拉取第 3 个服务端页");
  mockServerPage(requests.pop(), 3, 32, true);

  assert.equal(search1.searchResults.length, 10);
  assert.equal(search1.searchResults[0].gid, "comic_2_29", "第 7 页第 1 项为全局第 61 项");

  // 场景 3：回翻至已被淘汰的页（第 1 页，起始下标 0 < apiDroppedCount 32），基于 apiPageMap 重新拉取
  search1.changeDisplayPage(1);
  assert.equal(requests.length, 1, "回翻已淘汰页触发重新拉取");
  mockServerPage(requests.pop(), 1, 32, true);
  assert.equal(search1.displayPage, 1);
  assert.equal(search1.searchResults.length, 10);
  assert.equal(search1.searchResults[0].gid, "comic_1_1");

  // 场景 4：多组合测试：服务端 20 条/页，客户端 7 条/页连续翻页到最后一页
  clientPageSize = 7;
  requests.length = 0;
  const search2 = createSearch();
  search2.onInit();
  mockServerPage(requests.pop(), 1, 20, true);

  // 连续翻页
  for (let p = 2; p <= 6; p++) {
    search2.changeDisplayPage(p);
    while (requests.length > 0) {
      const req = requests.pop();
      const pageNum = parseInt(req.url.match(/page=(\d+)/)[1], 10);
      mockServerPage(req, pageNum, 20, pageNum < 4);
    }
    assert.equal(search2.displayPage, p);
    assert.ok(search2.searchResults.length > 0, `第 ${p} 页切片结果不得为空`);
  }
});

test("ime: square screen null check on candidate element prevents crash in en/num modes (P1-35)", async () => {
  const imeSource = read("../src/pages/ime/ime.ux").match(/<script>([\s\S]*?)<\/script>/)[1];

  let scrollCalled = 0;

  const context = vm.createContext({
    global: {
      __imeText: "initial",
      __imeLabel: "Search",
      screenShape: "rect",
    },
    console: { debug: noop, error: noop },
    Promise,
    router: { back: noop },
    vibrator: { vibrate: noop },
    device: {
      getInfo: ({ success }) => success({ windowWidth: 336 }),
    },
    SimpleInputMethod: {
      getHanzi: (word) => [["你", "好"], word],
    },
  });

  vm.runInContext(
    imeSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.imeDef = "),
    context
  );

  function createIme(screentype = "rect") {
    const candidateElement = {
      scrollTo: () => {
        scrollCalled++;
      },
    };

    const instance = Object.assign({}, context.imeDef, clone(context.imeDef.private), {
      screentype,
      $element: (id) => {
        if (id === "cvalWaiting") {
          // 方屏下，非中文或数字模式该元素不存在
          if (instance.screentype === "rect" && (instance.lang !== "cn" || instance.numFlag)) {
            return null;
          }
          return candidateElement;
        }
        return null;
      },
      adjustScreenWidth: () => {},
      onVibrate: noop,
    });
    return instance;
  }

  // 1. 方屏（rect）中文模式：元素存在，候选词复位正常调用 scrollTo
  const rectIme = createIme("rect");
  rectIme.onInit();
  rectIme.cval = "ni";
  rectIme.resetReslutList();
  assert.ok(scrollCalled > 0, "中文模式下元素存在，正常调用 scrollTo");

  // 2. 方屏（rect）切换至英文模式：元素在模板中不存在（$element 返回 null）
  // 按键输入、删除、清空等操作均调用 resetReslutList，不得抛出 TypeError
  rectIme.onBtnClick("lang");
  assert.equal(rectIme.lang, "en");

  assert.doesNotThrow(() => {
    rectIme.onSelect("H");
    rectIme.onSelect("I");
    rectIme.onBtnClick("space");
    rectIme.onBtnClick("D");
    rectIme.onBtnClick("AC");
  }, "英文模式下候选元素为空，所有按键均不得抛错");

  // 3. 方屏（rect）切换至数字模式：元素在模板中同样不存在
  rectIme.onBtnClick("lang"); // 回到 cn
  rectIme.onBtnClick("switchNum");
  assert.equal(rectIme.numFlag, true);

  assert.doesNotThrow(() => {
    rectIme.onBtnClick("1");
    rectIme.onBtnClick("2");
    rectIme.onBtnClick("D");
    rectIme.onBtnClick("AC");
    rectIme.resetReslutList();
  }, "数字模式下候选元素为空，所有操作均不得抛错");

  // 4. 反复切换模式
  assert.doesNotThrow(() => {
    rectIme.onBtnClick("switchChar");
    rectIme.onBtnClick("lang");
    rectIme.onBtnClick("lang");
    rectIme.onBtnClick("switchNum");
  });

  // 5. 圆屏（circle）回归验证
  const circleIme = createIme("circle");
  circleIme.onInit();
  assert.doesNotThrow(() => {
    circleIme.onBtnClick("lang");
    circleIme.onBtnClick("AC");
    circleIme.resetReslutList();
  }, "圆屏模式无回归");
});

test("api: cross-source health check and history cover proxy use correct source cookie without mismatch (P1-36)", async () => {
  const apiSource = read("../src/components/api.js");
  const coverLoaderSource = read("../src/components/coverLoader.js");

  const fetchCalls = [];

  const appGlobal = {
    userAgent: () => "TestUA/1.0",
    API_SETTING: {
      using: "sourceA",
      sourceA: { name: "Source A", apiUrl: "https://a.com" },
      sourceB: { name: "Source B", apiUrl: "https://b.com" },
      sourceC: { name: "Source C", apiUrl: "https://c.com" },
    },
    cookie: {
      sourceA: "auth_cookie_A=secretA",
      sourceB: "auth_cookie_B=secretB",
      // sourceC 无 cookie
    },
  };

  const fakeFetchModule = {
    isDirectAvailable: () => Promise.resolve(false), // 模拟需代理
    fetch: (options) => {
      fetchCalls.push(options);
      return Promise.resolve();
    },
  };

  const apiContext = vm.createContext({
    global: appGlobal,
    fetch: fakeFetchModule,
    Promise,
    URL,
    encodeURIComponent,
    appendCoverSuffix: (url, name) => `${url}#${name}`,
    console: { debug: noop, error: noop },
  });

  vm.runInContext(
    apiSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace(/^export \{.*?\} from .*?(;\r?\n|\r?\n)/gm, "")
      .replace(/^export /gm, "") +
      "\nglobalThis.api = { buildHeaders, apiFetch, checkSourceHealth, proxyImage };",
    apiContext
  );

  const { buildHeaders, checkSourceHealth, proxyImage } = apiContext.api;

  // 1. 测试 buildHeaders 与 apiFetch 针对 sourceKey 的透传和显式归属
  assert.equal(
    buildHeaders({}, "sourceA").Cookie,
    "auth_cookie_A=secretA",
    "显式 sourceA 提取 A 的 cookie"
  );
  assert.equal(
    buildHeaders({}, "sourceB").Cookie,
    "auth_cookie_B=secretB",
    "即使当前 using 是 sourceA，显式 sourceB 也能正确提取 B 的 cookie"
  );
  assert.equal(
    buildHeaders({}, "sourceC").Cookie,
    undefined,
    "无 cookie 的 sourceC 请求绝不携带其他源的 cookie"
  );
  assert.equal(
    buildHeaders({}).Cookie,
    "auth_cookie_A=secretA",
    "未显式指定 sourceKey 时兜底使用 using"
  );

  // 2. 测试 checkSourceHealth(sourceKey)
  fetchCalls.length = 0;
  checkSourceHealth("sourceB");
  await tick();
  assert.equal(fetchCalls.length, 1);
  const healthCall = fetchCalls[0];
  assert.equal(healthCall.url, "https://b.com/config");
  assert.equal(
    healthCall.header.Cookie,
    "auth_cookie_B=secretB",
    "健康检测源 B 必须带源 B 的 Cookie，不得带源 A 的 Cookie"
  );

  fetchCalls.length = 0;
  checkSourceHealth("sourceC");
  await tick();
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].header.Cookie,
    undefined,
    "检测无 Cookie 的源 C 时绝不携带源 A 或源 B 的认证头"
  );

  // 3. 测试 coverLoader 的跨源封面代理请求（历史记录多源混合）
  appGlobal.$api = apiContext.api;
  const coverContext = vm.createContext({
    global: appGlobal,
    file: { delete: noop },
    proxyImage: proxyImage,
    console: { debug: noop, error: noop },
  });

  vm.runInContext(
    coverLoaderSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace(/^export /gm, "") +
      "\nglobalThis.coverLoader = { loadCoverProxies };",
    coverContext
  );

  const { loadCoverProxies } = coverContext.coverLoader;

  const historyList = [
    { id: "h1", originalId: "1", source: "sourceB", cover: "https://b.com/img1.jpg" },
    { id: "h2", originalId: "2", source: "sourceC", cover: "https://c.com/img2.jpg" },
    { id: "h3", originalId: "3", source: "sourceA", cover: "https://a.com/img3.jpg" },
  ];

  fetchCalls.length = 0;
  loadCoverProxies(historyList, {
    getUrl: (item) => item.cover,
    getName: (item) => `${item.source}_${item.originalId}_cover`,
    getSourceKey: (item) => item.source,
    match: (row, item) => row.id === item.id,
    merge: (item, uri) => ({ ...item, coverLocal: uri }),
  });

  await tick();
  // 逐张加载第 1 张封面（sourceB）
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].header.Cookie,
    "auth_cookie_B=secretB",
    "混合历史列表加载 sourceB 封面必须使用 sourceB 的 Cookie"
  );

  // 模拟第 1 张完成，触发第 2 张（sourceC）
  fetchCalls.pop().success({ data: "internal://files/b1" });
  await tick();
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].header.Cookie,
    undefined,
    "加载 sourceC 封面不带任何 Cookie"
  );

  // 模拟第 2 张完成，触发第 3 张（sourceA）
  fetchCalls.pop().success({ data: "internal://files/c2" });
  await tick();
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].header.Cookie,
    "auth_cookie_A=secretA",
    "加载 sourceA 封面正确使用 sourceA 的 Cookie"
  );

  // 验证当前全局 using 始终没有被篡改
  assert.equal(appGlobal.API_SETTING.using, "sourceA", "全流程全局 using 保持稳定");
});

test("cover: separation of original URL and display URI allows seamless re-fetching after temp cleanup (P1-37)", async () => {
  const searchSource = read("../src/pages/search/search.ux").match(/<script>([\s\S]*?)<\/script>/)[1];

  const appGlobal = {
    APP_SETTING: {
      searchPageSize: 10,
      showCoverInSearch: true,
    },
    API_SETTING: {
      using: "sourceA",
      sourceA: { name: "Source A", apiUrl: "https://test.com" },
    },
    $img: { addCoverParams: (url) => url },
    $route: { serializeParams: (p) => p },
    $api: {
      buildSearchUrl: (text, page) => `https://test/search?q=${text}&page=${page}`,
      buildDetailUrl: (id) => `https://test/detail/${id}`,
      getFetchErrorType: () => "network",
      isComicDetailResponse: () => true,
      apiFetch: () => {},
    },
    $set: {
      getSearchPageSize: () => 10,
    },
    $cover: {
      loadCoverProxies(list, options) {
        list.forEach((item, idx) => {
          const url = options.getUrl(item);
          if (!url || !url.startsWith("http")) return;
          const uri = `internal://files/_icf_proxy_${idx}_seq_${appGlobal.__tempFilesCleanSeq || 0}`;
          const updated = options.merge(item, uri);
          list.splice(idx, 1, updated);
          if (options.onLocal) options.onLocal(item, updated);
        });
        return () => {};
      },
    },
    getTime: () => "12:00",
    __tempFilesCleanSeq: 0,
  };

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    Promise,
    router: { push: noop, replace: noop },
    prompt: { showToast: noop },
    setTimeout: (fn) => fn(),
  });

  vm.runInContext(
    searchSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.searchDef = "),
    context
  );

  const search = Object.assign({}, context.searchDef, clone(context.searchDef.private), {
    keyword: "test",
    $t: (k) => k,
    $element: () => ({ scrollTo: () => {} }),
    $nextTick: (fn) => fn(),
  });

  // 1. 初始化并模拟搜索结果到达
  search.onInit();
  search.ComicHandleSearchSuccess({
    data: {
      page: 1,
      has_more: false,
      results: [
        { comic_id: "c1", title: "Comic 1", cover_url: "https://test.com/c1.jpg" },
        { comic_id: "c2", title: "Comic 2", cover_url: "https://test.com/c2.jpg" },
      ],
    },
  });
  search.fillCurrentPage();

  assert.equal(search.searchResults.length, 2);
  // 原始 thumb 完整保留为 HTTP 地址，展示 URI 在 thumbDisplay 中
  assert.equal(search.searchResults[0].thumb, "https://test.com/c1.jpg", "原始 thumb 必须始终是 HTTP URL");
  assert.equal(search.searchResults[0].thumbDisplay, "internal://files/_icf_proxy_0_seq_0");

  // 2. 模拟用户在关于页点击清理临时文件：global.__tempFilesCleanSeq 递增
  appGlobal.__tempFilesCleanSeq = 1;

  // 3. 用户从关于页返回搜索页触发 onShow
  search.onShow();

  // 验证：检测到 cleanSeq 变化后，旧的已清理 thumbDisplay 被失效，并自动通过原始 HTTP URL 重新代理！
  assert.equal(search.searchResults[0].thumb, "https://test.com/c1.jpg", "原始 URL 依然完好保留");
  assert.equal(
    search.searchResults[0].thumbDisplay,
    "internal://files/_icf_proxy_0_seq_1",
    "展示 URI 自动重新拉取并更新为有效文件"
  );
});

test("source: global state synchronizes on disk write completion even if page was destroyed (P1-38)", async () => {
  const editSource = read("../src/pages/edit/edit.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
  const oobeSource = read("../src/pages/oobe/oobe.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
  const storageSource = read("../src/components/storage.js");
  const apiSource = read("../src/components/api.js");

  const filesOnDisk = new Map([
    ["internal://files/sources.json", Buffer.from(JSON.stringify([{ sourceOld: { name: "Old Source", apiUrl: "https://old.com" } }]))],
  ]);

  const fileMock = {
    readText(options) {
      const data = filesOnDisk.get(options.uri);
      if (data) options.success({ text: data.toString("utf8") });
      else options.fail("not found", 301);
    },
    writeText(options) {
      filesOnDisk.set(options.uri, Buffer.from(options.text, "utf8"));
      options.success();
    },
    access(options) {
      if (filesOnDisk.has(options.uri)) options.success();
      else options.fail("missing", 301);
    },
    move(options) {
      filesOnDisk.set(options.dstUri, filesOnDisk.get(options.srcUri));
      filesOnDisk.delete(options.srcUri);
      options.success();
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      if (options.success) options.success();
    },
  };

  const appGlobal = {
    userAgent: () => "TestUA",
    API_SETTING: {
      using: "sourceOld",
      sourceOld: { name: "Old Source", apiUrl: "https://old.com" },
    },
    cookie: {},
  };

  const storageContext = vm.createContext({
    global: appGlobal,
    file: fileMock,
    console: { debug: noop, error: noop },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
  });

  vm.runInContext(
    storageSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace(/^export /gm, "") +
      "\nglobalThis.storage = { updateJsonFile, SOURCES_URI, FILE_ERROR };",
    storageContext
  );

  const apiContext = vm.createContext({
    global: appGlobal,
    fetch: {
      fetch: (options) => {
        if (options.url.includes("/config")) {
          options.success({
            data: JSON.stringify({
              newSource: { name: "New Source", apiUrl: "https://new.com" },
            }),
          });
        }
        return Promise.resolve();
      },
    },
    Promise,
    URL,
    encodeURIComponent,
    console: { debug: noop, error: noop },
  });

  vm.runInContext(
    apiSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace(/^export \{.*?\} from .*?(;\r?\n|\r?\n)/gm, "")
      .replace(/^export /gm, "") +
      "\nglobalThis.api = { mergeSourcesToGlobal, ensureUsingSourceValid, replaceIfDuplicate, getFetchErrorType, apiFetch };",
    apiContext
  );

  appGlobal.$storage = storageContext.storage;
  appGlobal.$api = apiContext.api;
  appGlobal.$json = { safeJsonParse: (str, fallback) => { try { return JSON.parse(str); } catch (e) { return fallback; } } };
  appGlobal.createConfirmGuard = () => () => true;

  const toasts = [];
  const editContext = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    Promise,
    router: { back: noop, push: noop },
    prompt: { showToast: (t) => toasts.push(t) },
  });

  vm.runInContext(
    editSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.editDef = "),
    editContext
  );

  // 1. 测试添加源：写盘在途时页面被销毁（destroyed=true）
  const editPage = Object.assign({}, editContext.editDef, clone(editContext.editDef.private), {
    context: "new.com",
    $t: (k) => k,
  });
  editPage.onInit();

  // 触发拉取并写入 sources.json
  editPage.fetchSourceConfig("https");
  // 模拟在落盘完成回调触发前用户退出页面
  editPage.onDestroy();
  assert.equal(editPage.destroyed, true);

  await tick();
  await tick();

  // 校验：虽然页面已销毁，全局 API_SETTING 必须已经成功合并新源！
  assert.ok(appGlobal.API_SETTING.newSource, "即使页面销毁，全局内存依然同步合并了新源配置");
  assert.equal(appGlobal.API_SETTING.newSource.name, "New Source");

  // 2. 测试 OOBE 删除源：写盘在途时页面被销毁
  const oobeContext = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    Promise,
    router: { back: noop, push: noop },
    prompt: { showToast: (t) => toasts.push(t) },
  });

  vm.runInContext(
    oobeSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.oobeDef = "),
    oobeContext
  );

  const oobePage = Object.assign({}, oobeContext.oobeDef, clone(oobeContext.oobeDef.private), {
    sourceList: [{ key: "sourceOld", buildin: false }],
    $t: (k) => k,
  });

  oobePage.removeSource("sourceOld");
  // 模拟在删除落盘期间页面销毁
  oobePage.onDestroy();
  assert.equal(oobePage.destroyed, true);

  await tick();
  await tick();

  // 校验：全局 API_SETTING 必须已经删除 sourceOld，且 using 自动校准
  assert.equal(appGlobal.API_SETTING.sourceOld, undefined, "即使页面销毁，被删除源也成功从全局内存清除");
  assert.equal(appGlobal.API_SETTING.using, "newSource", "using 槽位已被安全校正指向可用源");
});

test("photo: first successful image display creates history snapshot and writes on exit without flipping (P1-39)", async () => {
  const photoSource = read("../src/pages/photo/photo.ux").match(/<script>([\s\S]*?)<\/script>/)[1];

  const filesOnDisk = new Map();

  const fileMock = {
    readText(options) {
      if (filesOnDisk.has(options.uri)) {
        options.success({ text: filesOnDisk.get(options.uri) });
      } else {
        options.fail("missing", 301);
      }
    },
    writeText(options) {
      filesOnDisk.set(options.uri, options.text);
      options.success();
    },
    access(options) {
      if (filesOnDisk.has(options.uri)) options.success();
      else options.fail("missing", 301);
    },
    move(options) {
      filesOnDisk.set(options.dstUri, filesOnDisk.get(options.srcUri));
      filesOnDisk.delete(options.srcUri);
      options.success();
    },
    delete(options) {
      filesOnDisk.delete(options.uri);
      if (options.success) options.success();
    },
  };

  let fetchShouldFail = false;
  const appGlobal = {
    APP_SETTING: { imageSize: "480", imageQuality: "50", imagePreload: false },
    API_SETTING: { using: "sourceA", sourceA: { apiUrl: "https://source.test" } },
    $img: {
      addImageParams: (url) => url,
      appendLvglSuffix: (url) => url,
    },
    $route: {
      parseParam: (p) => p,
    },
    $storage: {
      HISTORY_URI: "internal://files/history.json",
      updateJsonFile(uri, fallback, updater) {
        const current = filesOnDisk.has(uri) ? JSON.parse(filesOnDisk.get(uri)) : fallback;
        const updated = updater(current);
        filesOnDisk.set(uri, JSON.stringify(updated));
        return Promise.resolve(updated);
      },
      readHistory() {
        return Promise.resolve(filesOnDisk.has("internal://files/history.json")
          ? JSON.parse(filesOnDisk.get("internal://files/history.json")) : []);
      },
    },
    $api: {
      apiFetch(options) {
        if (fetchShouldFail) {
          if (options.fail) options.fail("network error", 500);
          return Promise.resolve();
        }
        if (options.responseType === "json") {
          options.success({
            data: {
              title: "Single Book 1",
              images: [{ url: "https://img.test/1.jpg" }, { url: "https://img.test/2.jpg" }],
            },
          });
        } else {
          // 模拟成功返回图片临时文件
          options.success({ data: "internal://files/photo_p1.jpg" });
        }
        return Promise.resolve();
      },
      buildPhotoUrl: () => "https://source.test/photo",
    },
    screenShape: "rect",
    deviceProduct: "test",
    getTime: () => "12:00",
  };

  const context = vm.createContext({
    global: appGlobal,
    file: fileMock,
    Promise,
    URL,
    console: { debug: noop, error: noop },
    brightness: { setMode: noop, setValue: noop },
    deleteFetchTemp: noop,
    clearPreloadCache: noop,
    trimPhotoCache: noop,
    parseParam: (p) => p,
    buildDigitRanges: () => [],
    router: { back: noop },
  });

  vm.runInContext(
    photoSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.photoDef = "),
    context
  );

  function createPhoto(params = {}) {
    return Object.assign({}, context.photoDef, clone(context.photoDef.private), {
      id: "single_book_1",
      title: "Single Book 1",
      total_chapters: 1,
      chapter: 1,
      page: 1,
      page_count: 10,
      local: false,
      $element: () => ({ scrollTo: () => {} }),
      $t: (k) => k,
    }, params);
  }

  // 1. 打开漫画，首张展示成功，不翻页直接退出（onHide / onDestroy）
  const photo = createPhoto();
  photo.onInit();
  await tick();

  // 模拟图片列表到达后请求第一页展示
  photo.ImageCache = ["https://img.test/1.jpg", "https://img.test/2.jpg"];
  photo.listReady = true;
  photo.getImageForPage();

  assert.equal(photo.images, "internal://files/photo_p1.jpg", "第一张图片成功展示");
  assert.equal(photo._historyDirty, true, "首张成功展示必须已标记 _historyDirty 快照");

  // 用户不翻页，直接退后台或退出页面
  photo.onHide();
  photo.onDestroy();
  await tick();

  // 验证：历史记录中已成功记录该漫画！
  const historyList = JSON.parse(filesOnDisk.get("internal://files/history.json"));
  assert.equal(historyList.length, 1, "只读首张后退出，历史记录中必须存在记录");
  assert.equal(historyList[0].originalId, "single_book_1");
  assert.equal(historyList[0].page, 1);
  assert.ok(historyList[0].last_read_time > 0);

  // 2. 验证已有历史记录再次打开只看第一张，退出时更新 last_read_time
  const oldTime = historyList[0].last_read_time;
  await new Promise((r) => setTimeout(r, 10));

  const photoAgain = createPhoto();
  photoAgain.onInit();
  await tick();
  photoAgain.ImageCache = ["https://img.test/1.jpg"];
  photoAgain.listReady = true;
  photoAgain.getImageForPage();

  photoAgain.onHide();
  photoAgain.onDestroy();
  await tick();

  const historyList2 = JSON.parse(filesOnDisk.get("internal://files/history.json"));
  assert.ok(
    historyList2[0].last_read_time >= oldTime,
    "再次阅读首张后退出，最近阅读时间更新"
  );

  // 3. 验证加载失败场景（如网络请求失败进入 errorState），不误记虚假历史
  filesOnDisk.delete("internal://files/history.json");
  fetchShouldFail = true;
  const failedPhoto = createPhoto({ id: "failed_book" });
  failedPhoto.onInit();
  await tick();

  assert.equal(failedPhoto.images, "");
  assert.equal(failedPhoto._historyDirty, false, "失败打开不得建立脏历史快照");

  failedPhoto.onHide();
  failedPhoto.onDestroy();
  await tick();

  assert.equal(
    filesOnDisk.has("internal://files/history.json"),
    false,
    "图片未成功展示（加载失败）不误记历史"
  );
});

test("search: invalid response on page flip resets display page indicator without misaligning content (P1-40)", async () => {
  const searchSource = read("../src/pages/search/search.ux").match(/<script>([\s\S]*?)<\/script>/)[1];

  const requests = [];
  const toasts = [];

  const appGlobal = {
    APP_SETTING: {
      searchPageSize: 10,
      showCoverInSearch: false,
    },
    $img: { addCoverParams: (url) => url },
    $route: { serializeParams: (p) => p },
    $api: {
      buildSearchUrl: (text, page) => `https://test/search?q=${text}&page=${page}`,
      buildDetailUrl: (id) => `https://test/detail/${id}`,
      getFetchErrorType: () => "network",
      isComicDetailResponse: () => true,
      apiFetch(options) {
        requests.push(options);
      },
    },
    $set: {
      getSearchPageSize: () => 10,
    },
    $cover: {
      loadCoverProxies: () => () => {},
    },
    getTime: () => "12:00",
  };

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    Promise,
    router: { push: noop, replace: noop },
    prompt: { showToast: (t) => toasts.push(t) },
    setTimeout: (fn) => fn(),
  });

  vm.runInContext(
    searchSource
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.searchDef = "),
    context
  );

  function createSearch() {
    return Object.assign({}, context.searchDef, clone(context.searchDef.private), {
      keyword: "test",
      $t: (k) => k,
      $element: () => ({ scrollTo: () => {} }),
      $nextTick: (fn) => fn(),
    });
  }

  // 1. 初始搜索第一页成功（10条数据）
  const search = createSearch();
  search.onInit();

  assert.equal(requests.length, 1);
  const req1 = requests.pop();
  req1.success({
    data: {
      page: 1,
      has_more: true,
      results: Array.from({ length: 10 }, (_, i) => ({
        comic_id: `comic_1_${i + 1}`,
        title: `Item 1-${i + 1}`,
        cover_url: `https://test/cover/1/${i + 1}`,
      })),
    },
  });
  if (req1.complete) req1.complete();

  assert.equal(search.displayPage, 1);
  assert.equal(search.searchResults.length, 10);
  assert.equal(search.searchResults[0].gid, "comic_1_1");

  // 2. 翻到第 2 页，触发网络请求拉取 serverPage 2
  search.changeDisplayPage(2);
  assert.equal(search.displayPage, 2);
  assert.equal(requests.length, 1);

  // 模拟服务端返回非法的对象结构（没有 results 数组，例如鉴权失败 JSON 或空响应）
  const req2 = requests.pop();
  req2.success({
    data: { error: "need login" }, // 非法响应
  });
  if (req2.complete) req2.complete();

  // 验证：displayPage 必须从 2 自动回退至实际内容所在页 1，Toast 给出提示！
  assert.equal(search.displayPage, 1, "非法响应后指示器必须自动回退至内容实际所在页码 1");
  assert.equal(search.searchResults.length, 10, "展示内容保持第 1 页内容");
  assert.equal(search.searchResults[0].gid, "comic_1_1");
  assert.equal(search.loadingMore, false);
  assert.ok(toasts.length > 0, "用户收到错误 Toast 提示");
});

test("update: retryCheck dynamically updates version, changelog, download URL and qr code without stale static bindings (P1-41)", async () => {
  const fullUpdateFile = read("../src/pages/update/update.ux");
  const templateSource = fullUpdateFile.match(/<template>([\s\S]*?)<\/template>/)[1];
  const updateScript = fullUpdateFile.match(/<script>([\s\S]*?)<\/script>/)[1];

  // 1. 验证模板层：动态节点不得含有 static / if.static / for.static
  assert.doesNotMatch(templateSource, /<text\s+static\s+class="main-title">/, "main-title 必须为动态绑定");
  assert.doesNotMatch(templateSource, /<text\s+static\s+class="version">/, "version 必须为动态绑定");
  assert.doesNotMatch(templateSource, /if\.static="\{\{\s*message\s*\}\}"/, "message 条件必须为动态 if");
  assert.doesNotMatch(templateSource, /for\.static="\{\{\s*item\s+in\s+changelogList\s*\}\}"/, "changelog 遍历必须为动态 for");
  assert.doesNotMatch(templateSource, /if\.static="\{\{\s*changelogList\.length\s*==\s*0\s*\}\}"/, "无日志提示必须为动态 if");
  assert.doesNotMatch(templateSource, /if\.static="\{\{\s*downloadUrl\s*\}\}"/, "下载卡片必须为动态 if");
  assert.doesNotMatch(templateSource, /<qrcode\s+static\s+class="download-qrcode"/, "二维码组件不得含有 static 标记");

  // 验证固定静态节点仍保留 static
  assert.match(templateSource, /<image\s+static\s+class="logo"/, "logo 保留 static 优化");
  assert.match(templateSource, /<span\s+static>\{\{\s*\$t\("update\.title"\)\s*\}\}<\/span>/, "标题保留 static 优化");
  assert.match(templateSource, /<text\s+static\s+class="qrcode-tip">/, "扫码提示保留 static 优化");

  // 2. 验证组件逻辑层：连续重查与撤销返回
  let checkUpdateResult = null;
  let backCount = 0;
  const toasts = [];

  const appGlobal = {
    screenShape: "rect",
    updatePageShowing: true,
    pendingUpdateInfo: {
      forceUpdate: true,
      currentVersionCode: 100,
      currentVersionName: "1.0.0",
      latestVersionCode: 101,
      latestVersionName: "1.0.1",
      title: "发现新版本 1.0.1",
      message: "请更新",
      changelog: "初始日志",
      downloadUrl: "", // 初始空地址
    },
    getTime: () => "12:00",
    checkUpdate: () => Promise.resolve(checkUpdateResult),
  };

  const context = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    Promise,
    router: {
      back: () => {
        backCount++;
      },
    },
    prompt: {
      showToast: (t) => toasts.push(t),
    },
  });

  vm.runInContext(
    updateScript
      .replace(/^import .*?(;\r?\n|\r?\n)/gm, "")
      .replace("export default ", "globalThis.updateDef = "),
    context
  );

  const update = Object.assign({}, context.updateDef, clone(context.updateDef.private), {
    $t: (k) => k,
  });

  // 初始加载
  update.onInit();
  assert.equal(update.currentVersionCode, 100);
  assert.equal(update.latestVersionCode, 101);
  assert.equal(update.downloadUrl, "");
  assert.deepEqual(clone(update.changelogList), ["初始日志"]);
  assert.equal(update.message, "请更新");

  // 第一次重试检查：服务端下发了新修复的包信息与下载地址
  checkUpdateResult = {
    forceUpdate: true,
    currentVersionCode: 100,
    currentVersionName: "1.0.0",
    latestVersionCode: 102,
    latestVersionName: "1.0.2",
    title: "紧急修复版本 1.0.2",
    message: "新增离线下载修复",
    changelog: ["修复下载崩溃", "提升通信稳定性"],
    downloadUrl: "https://example.com/bandcomic-102.rpk",
  };

  update.retryCheck();
  await tick();

  assert.equal(update.latestVersionCode, 102, "最新版本号已更新为 102");
  assert.equal(update.latestVersionName, "1.0.2", "最新版本名已更新为 1.0.2");
  assert.equal(update.updateTitle, "紧急修复版本 1.0.2", "标题已更新");
  assert.equal(update.message, "新增离线下载修复", "提示信息已更新");
  assert.deepEqual(clone(update.changelogList), ["修复下载崩溃", "提升通信稳定性"], "日志列表已更新");
  assert.equal(update.downloadUrl, "https://example.com/bandcomic-102.rpk", "下载地址已从空更新为有效 URL");

  // 第二次重试检查：服务端撤回了更新（返回 null），更新页自动放行返回首页
  checkUpdateResult = null;
  update.retryCheck();
  await tick();

  assert.equal(appGlobal.updatePageShowing, false, "撤回更新后 updatePageShowing 复位为 false");
  assert.equal(backCount, 1, "撤回更新后成功调用 router.back() 放行返回");
});






