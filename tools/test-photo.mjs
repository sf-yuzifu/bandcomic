// Run the real reader with in-memory Vela files, requests and reading history.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const photoSource = read("../src/pages/photo/photo.ux").match(/<script>([\s\S]*?)<\/script>/)[1];
const routeSource = read("../src/components/routerParams.js");
const clone = (value) => JSON.parse(JSON.stringify(value));
const noop = () => {};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness({ local = true, serial = true, pageCount = 3, bin = false,
  missing = [], preload = false, history = [], shape = "rect",
  screenSize = { width: 480, height: 480 }, scrollHeight = screenSize.height * 2 } = {}) {
  const files = new Set(), accesses = [], requests = [];
  let savedHistory = clone(history);
  const chapters = [["第一章", pageCount, 5, "chapter-v1"], ["第二章", 2, 9, "chapter-v2"]];
  const pageUri = (chapter, page) => {
    const entry = chapters[chapter - 1];
    const root = serial ? `${entry[3]}/${entry[2]}　${entry[0]}` : "book-v1";
    return `internal://files/${root}/${page}${bin ? ".bin" : ""}`;
  };
  for (let chapter = 1; chapter <= (serial ? chapters.length : 1); chapter++) {
    for (let page = 1; page <= chapters[chapter - 1][1]; page++) {
      if (chapter !== 1 || !missing.includes(page)) files.add(pageUri(chapter, page));
    }
  }
  const appGlobal = {
    $img: { addImageParams: (url) => url, appendLvglSuffix: (url) => url },
    $route: {},
    $storage: {
      HISTORY_URI: "internal://files/history.json",
      readHistory: () => Promise.resolve(clone(savedHistory)),
      updateJsonFile: (uri, fallback, updater) => {
        savedHistory = clone(updater(savedHistory));
        return Promise.resolve(savedHistory);
      },
      sanitizeFolderName: (name) => name,
    },
    $api: {
      buildPhotoUrl: (id, chapter) => `https://source.test/chapter/${chapter}`,
      apiFetch: (options) => {
        requests.push(options);
        if (options.responseType === "json") {
          const chapter = Number(options.url.split("/").pop());
          const entry = chapters[chapter - 1];
          options.success({ data: {
            title: entry[0],
            images: Array.from({ length: entry[1] }, (_, page) => ({
              url: `https://source.test/image/${chapter}/${page + 1}`,
            })),
          } });
        } else {
          options.success({ data: `internal://files/_icf_test_${requests.length}` });
        }
      },
    },
    API_SETTING: { using: "test", test: {} },
    APP_SETTING: { imageSize: "480", imageQuality: "50", imagePreload: preload },
    screenShape: shape,
    screenSize,
    getTime: () => "12:00",
  };
  const context = vm.createContext({
    global: appGlobal,
    console: { debug: noop, error: noop },
    file: {
      access: (options) => {
        accesses.push(options.uri);
        if (files.has(options.uri)) options.success();
        else options.fail("missing", 301);
      },
      delete: (options) => files.delete(options.uri),
    },
    router: { back: noop },
    prompt: { showToast: noop },
    vibrator: { vibrate: noop },
  });
  vm.runInContext(routeSource.replace(/^export /gm, "") + "\nglobal.$route.parseParam = parseParam;", context);
  vm.runInContext(photoSource.replace(/^import .*;\r?\n/gm, "")
    .replace("export default ", "globalThis.photoDef = "), context);
  const page = Object.assign({}, context.photoDef, clone(context.photoDef.private), {
    id: "book",
    storageId: "book-v1",
    title: "Book",
    local,
    is_serial: serial,
    // Local serial readers must use chapter metadata even with a stale route count.
    page_count: local && serial ? 0 : pageCount,
    total_chapters: serial ? chapters.length : 0,
    downloadChapter: JSON.stringify(chapters),
    $element: () => ({
      scrollTo: noop,
      getScrollRect: (options) => options.success({
        width: screenSize.width - (shape === "circle" ? 12 : 0),
        height: scrollHeight,
      }),
    }),
    $t: (key) => key,
  });
  page.onInit();
  await tick();
  return { page, files, accesses, requests, pageUri, history: () => savedHistory };
}

function assertEnd(page, total) {
  assert.equal(page.page, total + 1, "one extra internal page represents the end state");
  assert.equal(page.page_count, total, "navigation must not grow the chapter's total");
  assert.equal(page.images, "");
  assert.equal(page.loading, "end");
  assert.equal(page.showit, true, "the end state keeps the navigation toolbar available");
}

test("photo: chapter end stays bounded, saves the last real page and supports backward navigation", async (t) => {
  for (const options of [
    { local: true, serial: true },
    { local: true, serial: true, bin: true },
    { local: true, serial: false },
    { local: true, serial: false, bin: true },
    { local: false, serial: true },
    { local: false, serial: true, preload: true },
    { local: false, serial: false },
    { local: false, serial: false, preload: true },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const h = await harness(options);
      const p = h.page;
      p.toPage("+");
      p.toPage("+");
      assert.equal(p.page, 3);
      assert.ok(p.images);
      const lastImage = p.images;
      const accessCount = h.accesses.length;
      const requestCount = h.requests.length;
      p.showit = false;
      p.toPage("+");
      assertEnd(p, 3);
      for (let i = 0; i < 3; i++) {
        p.toPage("+");
        assertEnd(p, 3);
      }
      assert.equal(h.accesses.length, accessCount, "no local access beyond the last page");
      assert.equal(h.requests.length, requestCount, "no online fetch beyond the last page");
      p.onHide();
      assert.equal(h.history()[0].page, 3);
      assert.equal(h.history()[0].page_count, 3);
      if (options.local && options.serial) assert.equal(h.history()[0].chapterNum, 5);
      p.toPage("-");
      assert.equal(p.page, 3);
      assert.equal(p.images, lastImage);
      p.onDestroy();
    });
  }
});

test("photo: zero-page chapters enter the end state without inventing or reading a page", async (t) => {
  for (const local of [true, false]) {
    for (const serial of [true, false]) {
      await t.test(JSON.stringify({ local, serial }), async () => {
        const h = await harness({ local, serial, pageCount: 0 });
        assertEnd(h.page, 0);
        h.page.toPage("+");
        assertEnd(h.page, 0);
        assert.equal(h.accesses.length, 0);
        assert.equal(h.requests.filter((r) => r.responseType === "file").length, 0);
      });
    }
  }
});

test("photo: missing pages within the chapter remain retryable errors, including the last page", async (t) => {
  for (const missingPage of [2, 3]) {
    await t.test(`missing page ${missingPage}`, async () => {
      const h = await harness({ missing: [missingPage] });
      for (let page = 1; page < missingPage; page++) h.page.toPage("+");
      assert.equal(h.page.page, missingPage);
      assert.equal(h.page.page_count, 3);
      assert.equal(h.page.images, "");
      assert.equal(h.page.loading, "", "a missing declared page is not a completed chapter");
      h.page.onStateClick();
      assert.equal(h.page.page, missingPage);
      assert.equal(h.page.loading, "");
      h.files.add(h.pageUri(1, missingPage));
      h.page.onStateClick();
      assert.equal(h.page.images, h.pageUri(1, missingPage));
      while (h.page.page <= 3) h.page.toPage("+");
      assertEnd(h.page, 3);
    });
  }
});

test("photo: switching chapters from the end uses the new chapter's own page count", async () => {
  const h = await harness();
  for (let i = 0; i < 3; i++) h.page.toPage("+");
  assertEnd(h.page, 3);
  h.page.toChapter("+");
  assert.equal(h.page.page, 1);
  assert.equal(h.page.page_count, 2);
  assert.equal(h.page.title, "第二章");
  assert.equal(h.page.images, h.pageUri(2, 1));
  assert.equal(h.history()[0].chapterNum, 9);
  h.page.toPage("+");
  h.page.toPage("+");
  assertEnd(h.page, 2);
  h.page.toChapter("-");
  assert.equal(h.page.page, 1);
  assert.equal(h.page.page_count, 3);
  assert.equal(h.page.images, h.pageUri(1, 1));
});

test("photo: an inflated legacy history page is clamped to the chapter metadata on reopen", async () => {
  const h = await harness({ history: [{ id: "local_book", originalId: "book",
    chapter: 5, chapterNum: 5, page: 50, page_count: 50 }] });
  assert.equal(h.page.page, 3);
  assert.equal(h.page.page_count, 3);
  assert.equal(h.page.images, h.pageUri(1, 3));
  h.page.toPage("+");
  assertEnd(h.page, 3);
  h.page.onHide();
  assert.equal(h.history()[0].page, 3);
  assert.equal(h.history()[0].page_count, 3);
});

test("photo: rectangle and circle scrolling turn pages after two exact edge hits", async (t) => {
  for (const { shape, screenSize } of [
    { shape: "rect", screenSize: { width: 336, height: 480 } },
    { shape: "rect", screenSize: { width: 480, height: 480 } },
    { shape: "circle", screenSize: { width: 480, height: 480 } },
  ]) {
    for (const local of [true, false]) {
      await t.test(JSON.stringify({ shape, screenSize, local }), async () => {
        const h = await harness({ shape, screenSize, local });
        const p = h.page;
        const viewportHeight = screenSize.height - (shape === "circle" ? 12 : 0);
        const bottom = screenSize.height * 2 - viewportHeight;
        const scroll = (y) => p.onScroll({ scrollX: 0, scrollY: y });
        await scroll(bottom - 10);
        await scroll(bottom);
        assert.equal(p.page, 1, "the first bottom hit only arms navigation");
        await scroll(bottom);
        assert.equal(p.page, 1, "a duplicate coordinate is not another edge hit");
        await scroll(bottom + 8);
        assert.equal(p.page, 1, "overscroll alone must not satisfy the second hit");
        await scroll(bottom);
        assert.equal(p.page, 2, "returning to the exact bottom performs the second hit");
        assert.ok(p.images);

        await scroll(20);
        await scroll(0);
        assert.equal(p.page, 2, "the first top hit only arms navigation");
        await scroll(0);
        await scroll(-8);
        assert.equal(p.page, 2, "duplicates and top overscroll do not turn a page");
        await scroll(0);
        assert.equal(p.page, 1);
        assert.ok(p.images);
      });
    }
  }
});

test("photo: rectangle scrolling uses the actual bottom with fractional content height", async () => {
  const h = await harness({ scrollHeight: 960.5 });
  await h.page.onScroll({ scrollX: 0, scrollY: 480.5 });
  assert.equal(h.page.page, 1);
  await h.page.onScroll({ scrollX: 0, scrollY: 488.5 });
  assert.equal(h.page.page, 1);
  await h.page.onScroll({ scrollX: 0, scrollY: 480.5 });
  assert.equal(h.page.page, 2);
});

test("photo: rectangle scroll navigation enters the chapter end without reading extra pages", async (t) => {
  for (const local of [true, false]) {
    await t.test(`local=${local}`, async () => {
      const h = await harness({ local });
      h.page.toPage("+");
      h.page.toPage("+");
      const accessCount = h.accesses.length;
      const requestCount = h.requests.length;
      h.page.showit = false;
      for (const y of [470, 480, 488, 480]) {
        await h.page.onScroll({ scrollX: 0, scrollY: y });
      }
      assertEnd(h.page, 3);
      await h.page.onScroll({ scrollX: 0, scrollY: 488 });
      await h.page.onScroll({ scrollX: 0, scrollY: 480 });
      assertEnd(h.page, 3);
      assert.equal(h.accesses.length, accessCount);
      assert.equal(h.requests.length, requestCount);
      h.page.onHide();
      assert.equal(h.history()[0].page, 3);
      assert.equal(h.history()[0].page_count, 3);
      h.page.toPage("-");
      assert.equal(h.page.page, 3);
      assert.ok(h.page.images);
    });
  }
});

test("photo: diagonal movement and horizontal overscroll do not trigger edge navigation", async () => {
  const h = await harness();
  h.page.toPage("+");
  for (const [x, y] of [[4, 480], [4, 488], [5, 480], [5, 488], [5, 480]]) {
    await h.page.onScroll({ scrollX: x, scrollY: y });
  }
  assert.equal(h.page.page, 2);
});
