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
  const quiet = { debug: noop, error: noop };
  const storageContext = vm.createContext({ file, console: quiet, Promise });
  vm.runInContext(storageSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") +
    "\nglobalThis.storage = { updateComicMeta, isAlreadyExistsError, readComics, sanitizeFolderName };", storageContext);
  const appGlobal = {
    API_SETTING: { using: "source", source: { apiUrl: "https://source.test" } },
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
  vm.runInContext(imageSource.replace(/^export /gm, "") +
    "\nglobal.$img = { addImageParams, addCoverParams, appendCoverSuffix, appendLvglSuffix };", imageContext);
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

