import file from "@system.file";
import { readComics, updateJsonFile, COMICS_URI, FILE_ERROR, acquireComicMutation, protectDir,
  validStorageId, sanitizeFolderName, comicStorageIds, comicChapterUri, comicContentIdentity, scanComicStorage } from "./storage";
import { isValidImageFile } from "./imageFile";

export const CHAPTER_IMPORT_PROTOCOL = 1;
let stageSequence = 0;

export function legacyComicImportPlan(header) {
  const isSerial = header.mode === "multi";
  const chapters = isSerial ? header.chapters : [{ chapterNum: 1, title: "第1章",
    pageCount: (header.files || []).filter((f) => f !== "cover").length, files: (header.files || []).filter((f) => f !== "cover") }];
  if (!Array.isArray(chapters) || (header.mode !== "single" && !isSerial)) throw new Error("导入文件清单无效");
  chapters.forEach((c) => {
    if (!Array.isArray(c.files) || c.files.length !== c.pageCount ||
        new Set(c.files.map((f) => String(f).split(".")[0])).size !== c.pageCount ||
        c.files.some((f) => typeof f !== "string" || !/^\d+(\.bin)?$/.test(f) || +f.split(".")[0] < 1 || +f.split(".")[0] > c.pageCount) ||
        (isSerial && c.name !== c.chapterNum + "　" + sanitizeFolderName(c.title.trim() || "第" + c.chapterNum + "章"))) {
      throw new Error("章节目录或页文件清单无效");
    }
  });
  return { ...header, isSerial, chapters };
}

function checkPlan(plan) {
  if (plan.importChapterProtocol !== CHAPTER_IMPORT_PROTOCOL || !validStorageId(plan.bookId) ||
      !["replace_book", "upsert_chapters"].includes(plan.operation) || typeof plan.name !== "string" || !plan.name.trim() ||
      typeof plan.isSerial !== "boolean" || !Array.isArray(plan.chapters) || !plan.chapters.length ||
      (plan.operation === "upsert_chapters" && !plan.isSerial) ||
      (plan.targetComicId && (!validStorageId(plan.targetComicId) || !plan.targetComicId.startsWith("local_")))) {
    throw new Error("导入作品/操作参数无效");
  }
  const numbers = new Set();
  plan.chapters.forEach((c) => {
    if (!Number.isInteger(c.chapterNum) || c.chapterNum < 1 || c.chapterNum > 100000 || numbers.has(c.chapterNum) ||
        !Number.isInteger(c.pageCount) || c.pageCount < 1 || c.pageCount > 100000 || typeof c.title !== "string") {
      throw new Error("导入真实章号/页数无效或重复");
    }
    numbers.add(c.chapterNum);
  });
  if (!plan.isSerial && plan.chapters.length !== 1) throw new Error("单本不能包含多个章节");
}

function removeStage(id) {
  file.rmdir({ uri: "internal://files/" + id, recursive: true, fail() {} });
}

export async function beginComicImport(input) {
  const plan = JSON.parse(JSON.stringify(input));
  checkPlan(plan);
  let list;
  try { list = await readComics(true); }
  catch (error) { if (error.code !== FILE_ERROR.NOT_FOUND) throw error; list = []; }
  if (!Array.isArray(list)) throw new Error("漫画索引格式无效");
  const matches = list.filter((c) => c && (plan.targetComicId ? c.id === plan.targetComicId : c.bookId === plan.bookId));
  if (matches.length > 1 || (plan.targetComicId && matches.length !== 1)) throw new Error("导入目标已失效或不唯一，请重新读取书架");
  const existing = matches[0] || null;
  if (existing && (!existing.id.startsWith("local_") ||
      (plan.operation === "upsert_chapters" && !existing.is_serial))) throw new Error("追加目标必须是本地连载漫画");
  if (existing && !existing.bookId && list.some((c) => c && c !== existing && c.bookId === plan.bookId)) {
    throw new Error("当前作品身份已关联另一作品，请用新整理身份选择此目标");
  }
  const targetId = existing ? existing.id : "local_" + plan.bookId;
  if (list.some((c) => c && c.id === targetId && c !== existing)) throw new Error("作品身份冲突，请选择已有目标");
  const owner = acquireComicMutation(targetId);
  if (!owner) throw new Error("该漫画正在下载、导入或删除，请稍后重试");
  let stageId = plan.stageId || null;
  try {
    if (!stageId) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = "local_stage_" + Date.now() + "_" + (++stageSequence) + "_" + Math.random().toString(36).slice(2, 10);
        const exists = await new Promise((resolve, reject) => file.access({ uri: "internal://files/" + candidate,
          success: () => resolve(true), fail: (data, code) => code === FILE_ERROR.NOT_FOUND ? resolve(false) : reject({ data, code }) }));
        if (!exists) { stageId = candidate; break; }
      }
    }
    if (!stageId) throw new Error("无法创建独立导入版本目录");
  } catch (error) { owner.release(); throw error; }
  const unprotect = protectDir(stageId);
  const tx = { plan, targetId, stageId, existing, expected: existing && comicContentIdentity(existing),
    draft: { id: stageId, chapters: [] }, cancelled: false, committed: false, commitStarted: false,
    commitPromise: null, result: null };
  let references = 1;
  const releaseOne = () => {
    if (--references !== 0) return;
    if (!tx.committed && !tx.keepStage) removeStage(stageId);
    unprotect();
    owner.release();
  };
  const once = () => { let released = false; return () => { if (!released) { released = true; releaseOne(); } }; };
  tx.lease = { release: once(), retain() { references++; return once(); } };
  return tx;
}

export function abortComicImport(tx) {
  if (tx.commitStarted) return; // Submitted atomic index write decides the outcome.
  tx.cancelled = true;
  tx.lease.release();
}

async function validateVersion(tx, chapters, coverSaved) {
  for (const chapter of chapters) {
    if (tx.cancelled) throw new Error("导入已取消");
    const prefix = "internal://files/" + tx.stageId + (tx.plan.isSerial ? "/" + chapter.num + "　" + chapter.name : "");
    for (let page = 1; page <= chapter.page_count; page++) {
      let valid = false;
      for (const suffix of [".bin", ""]) {
        try {
          if (await isValidImageFile(prefix + "/" + page + suffix, true, () => !tx.cancelled)) { valid = true; break; }
        } catch (error) { if (error.code !== FILE_ERROR.NOT_FOUND) throw error; }
      }
      if (!valid) throw new Error("第" + chapter.num + "章第" + page + "页未有效保存");
    }
  }
  if (coverSaved && !await isValidImageFile("internal://files/" + tx.stageId + "/cover", false, () => !tx.cancelled)) {
    throw new Error("封面文件无效");
  }
}

export function commitComicImport(tx, coverSaved) {
  if (tx.commitPromise) return tx.commitPromise;
  tx.commitPromise = (async () => {
    const incoming = tx.plan.chapters.map((c) => ({ num: tx.plan.isSerial ? c.chapterNum : 0,
      name: tx.plan.isSerial ? sanitizeFolderName(c.title.trim() || "第" + c.chapterNum + "章") : "",
      page_count: c.pageCount, downloaded: c.pageCount, storageId: tx.stageId }));
    await validateVersion(tx, incoming, coverSaved);
    const stage = { id: tx.stageId, is_serial: tx.plan.isSerial, chapters: incoming, coverMissing: !coverSaved };
    const stats = await scanComicStorage(stage);
    incoming.forEach((c, i) => { c.size = stats.chapters[i].size || 0; });
    let oldRoots = [];
    let oldChapters = [];
    let record;
    const releaseWrite = tx.lease.retain();
    try {
      await updateJsonFile(COMICS_URI, [], (list) => {
        if (tx.cancelled || !Array.isArray(list)) throw new Error("导入已取消或索引无效");
        const matches = list.filter((c) => c && c.id === tx.targetId);
        if (tx.existing ? matches.length !== 1 || comicContentIdentity(matches[0]) !== tx.expected : matches.length !== 0) {
          throw new Error("导入目标内容已改变，请重新读取书架");
        }
        const previous = matches[0];
        if (previous) {
          oldRoots = comicStorageIds(previous);
          if (previous.is_serial) oldChapters = (previous.chapters || []).map((c) => comicChapterUri(previous, c));
        }
        const merge = tx.plan.operation === "upsert_chapters" && previous;
        const chapters = merge ? (previous.chapters || []).filter((c) => !incoming.some((n) => n.num === c.num)).concat(incoming) : incoming;
        chapters.sort((a, b) => a.num - b.num);
        record = { ...(previous || {}), id: tx.targetId, bookId: previous && previous.bookId || tx.plan.bookId,
          name: merge ? previous.name : tx.plan.name, is_serial: tx.plan.isSerial,
          storageId: merge ? previous.storageId || previous.id : tx.stageId,
          coverMissing: merge ? !!previous.coverMissing : !coverSaved,
          chapters, page_count: chapters.reduce((n, c) => n + c.page_count, 0),
          total_chapters: Math.max(merge ? previous.total_chapters || 0 : 0, tx.plan.totalChapters || 0,
            ...tx.plan.chapters.map((c) => c.chapterNum)), downloaded_at: Date.now(), revision: tx.plan.revision || tx.stageId };
        delete record.size; // Different chapter roots must be counted by reference.
        tx.commitStarted = true;
        return list.filter((c) => !c || c.id !== tx.targetId).concat(record);
      }, { requireValid: true });
      tx.committed = true;
      tx.result = record;
    } finally { releaseWrite(); }
    // Recheck the complete index before removing roots; other books may reference them.
    try {
      const current = await readComics(true);
      const used = new Set(current.reduce((ids, c) => c ? ids.concat(comicStorageIds(c)) : ids, []));
      oldRoots.filter((id) => !used.has(id)).forEach(removeStage);
      const usedChapters = new Set(current.reduce((paths, c) => c && c.is_serial ?
        paths.concat((c.chapters || []).map((chapter) => comicChapterUri(c, chapter))) : paths, []));
      oldChapters.filter((path) => !usedChapters.has(path) && used.has(path.split("/")[3]))
        .forEach((uri) => file.rmdir({ uri, recursive: true, fail() {} }));
    } catch (error) { console.debug("旧导入版本清理待重试"); }
    tx.lease.release();
    if (record.storageId !== tx.stageId && coverSaved) file.delete({ uri: "internal://files/" + tx.stageId + "/cover", fail() {} });
    return record;
  })().catch(async (error) => {
    if (tx.commitStarted) {
      try {
        const list = await readComics(true);
        const record = list.find((c) => c && c.id === tx.targetId && comicStorageIds(c).includes(tx.stageId));
        if (record) { tx.committed = true; tx.result = record; tx.lease.release(); return record; }
      } catch (readError) { tx.keepStage = true; }
    }
    tx.commitStarted = false;
    abortComicImport(tx);
    throw error;
  });
  return tx.commitPromise;
}
