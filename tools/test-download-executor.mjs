import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const httpResponseCode = fs.readFileSync(
  new URL("../src/components/httpResponse.js", import.meta.url),
  "utf8"
);
const imageFileCode = fs.readFileSync(
  new URL("../src/components/imageFile.js", import.meta.url),
  "utf8"
);
const executorCode = fs.readFileSync(
  new URL("../src/components/downloadExecutor.js", import.meta.url),
  "utf8"
);

function createExecutorSandbox(options = {}) {
  const { files = new Map(), fetchMock = null } = options;
  const deletedFiles = [];
  const movedFiles = [];

  const file = {
    get(opts) {
      if (files.has(opts.uri)) {
        opts.success({ length: files.get(opts.uri).length });
      } else {
        opts.fail("not found", 301);
      }
    },
    readArrayBuffer(opts) {
      if (files.has(opts.uri)) {
        const full = files.get(opts.uri);
        const slice = full.slice(opts.position, opts.position + opts.length);
        opts.success({ buffer: slice.buffer });
      } else {
        opts.fail("not found", 301);
      }
    },
    delete(opts) {
      deletedFiles.push(opts.uri);
      files.delete(opts.uri);
      if (opts.success) opts.success();
    },
    move(opts) {
      movedFiles.push({ src: opts.srcUri, dst: opts.dstUri });
      if (files.has(opts.srcUri)) {
        files.set(opts.dstUri, files.get(opts.srcUri));
        files.delete(opts.srcUri);
      }
      if (opts.success) opts.success();
    },
  };

  const sandbox = {
    require(id) {
      if (id === "@system.file") return file;
      throw new Error("Unknown: " + id);
    },
    Promise,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
    console: { debug() {}, info() {}, warn() {}, error() {} },
    protectTempFile: () => () => {},
  };

  const context = vm.createContext(sandbox);

  vm.runInContext(
    httpResponseCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    imageFileCode.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, ""),
    context
  );
  vm.runInContext(
    executorCode
      .replace(/^import[\s\S]*?;\r?\n/gm, "")
      .replace(/export (const|function|async function|let|var)/g, "$1"),
    context
  );

  return { context, files, deletedFiles, movedFiles, fetchMock };
}

// 4-byte valid JPEG header
const VALID_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const INVALID_DATA = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);

test("downloadExecutor: skips when target file already exists and is valid", async () => {
  const files = new Map([["internal://files/book1/1", VALID_JPEG]]);
  const { context } = createExecutorSandbox({ files });

  let fetchCalled = false;
  const state = context.createDownloadState();
  const res = await context.downloadSingleImage({
    url: "http://example.com/1.jpg",
    fileUri: "internal://files/book1/1",
    state,
    fetchFn: async () => {
      fetchCalled = true;
    },
  });

  assert.equal(res.skipped, true);
  assert.equal(fetchCalled, false);
});

test("downloadExecutor: deletes corrupted existing file and re-downloads", async () => {
  const files = new Map([
    ["internal://files/book1/1", INVALID_DATA],
    ["internal://cache/temp_1", VALID_JPEG],
  ]);
  const { context, deletedFiles, movedFiles } = createExecutorSandbox({ files });

  let fetchCalled = false;
  const state = context.createDownloadState();
  const res = await context.downloadSingleImage({
    url: "http://example.com/1.jpg",
    fileUri: "internal://files/book1/1",
    state,
    fetchFn: async () => {
      fetchCalled = true;
      return { code: 200, statusCode: 200, data: "internal://cache/temp_1" };
    },
  });

  assert.equal(fetchCalled, true);
  assert.equal(res.skipped, false);
  assert.ok(deletedFiles.includes("internal://files/book1/1"));
  assert.ok(movedFiles.some((m) => m.src === "internal://cache/temp_1" && m.dst === "internal://files/book1/1"));
});

test("downloadExecutor: cleans up temp file when downloaded image is corrupted", async () => {
  const files = new Map([["internal://cache/temp_corrupt", INVALID_DATA]]);
  const { context, deletedFiles } = createExecutorSandbox({ files });

  const state = context.createDownloadState();
  await assert.rejects(
    () =>
      context.downloadSingleImage({
        url: "http://example.com/bad.jpg",
        fileUri: "internal://files/book1/2",
        state,
        fetchFn: async () => {
          return { code: 200, statusCode: 200, data: "internal://cache/temp_corrupt" };
        },
      }),
    /Corrupted/
  );

  assert.ok(deletedFiles.includes("internal://cache/temp_corrupt"));
});

test("downloadExecutor: respects cancellation before/during download", async () => {
  const files = new Map([["internal://cache/temp_cancelled", VALID_JPEG]]);
  const { context, deletedFiles } = createExecutorSandbox({ files });

  const state = context.createDownloadState();
  context.cancelDownload(state);

  await assert.rejects(
    () =>
      context.downloadSingleImage({
        url: "http://example.com/cancel.jpg",
        fileUri: "internal://files/book1/3",
        state,
        fetchFn: async () => {
          return { code: 200, statusCode: 200, data: "internal://cache/temp_cancelled" };
        },
      }),
    /download_aborted/
  );
});
