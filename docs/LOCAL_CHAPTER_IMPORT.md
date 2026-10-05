# 本地章节追加、更新与整书替换规范

> 协议版本标识：`importChapterProtocol: 1`（研发代号：HTTP-9-A）

## 使用方式

同时安装最新腕上漫画快应用与同步器。握手声明 `importChapterProtocol: 1` 后，HTTP 与互联分片导入使用相同的作品定位和提交规则。

- **发送整本到设备**：首次新建作品；再次发送同一作品身份，或已选择设备上的目标作品时，替换该作品的完整内容。
- **仅发送本章到设备**：按真实章号追加/更新。不存在的章号新增，已有章号替换，其他章节及已有作品书名、封面保留。
- **选择已有目标**：先在「设备书架」读取完整列表，在本地作品卡片内部点击「作为本地导入目标」，该卡片显示已选状态。整理页上方显示目标作品名称、完整 ID、封面、选择时页数/章数概要及所属设备；下方明确标注「待发送草稿」。发送时核对目标所属设备。设备仍会核验该 ID 是否存在、是否为本地作品，以及追加目标是否为连载。
- **真实章号**：章节正文编辑页可设置 `1..100000` 的章号；非空章节不能重复。移除前面的编辑项不会改变后面的章号。仅发送第 5 章仍按第 5 章登记，只发送第 1 章也保持连载结构。

当前整理内容的 `bookId` 在本次运行内保持稳定，改名或多次发送不会生成另一作品身份。清空整理内容生成新身份；重启草稿恢复仍按 P3-22 后续推进。重新整理旧书时，选择设备上的已有作品作为目标。名称只用于展示，新版不按同名自动覆盖。

**目标选择与内容编辑的边界**：选择目标是在指定本次草稿要发送到哪条设备记录。目标预览使用已回传的作品概要和小封面，不读取设备已有章节清单/正文，也不把现有作品恢复为完整编辑草稿。选中、切换或取消目标都保留当前本地草稿。要新增/更新某章，仍需在插件选择该章的本地图片并设置真实章号后发送；完整回读、页序编辑或单独删除设备已有章节需要后续补充章节/正文回传能力。

未声明能力的旧端保留既有整书导入；单章明确发送为「书名 - 章名」的独立单本。已选择 ID 目标时，旧端会提示更新快应用，不忽略目标选择。即使旧端支持 HTTP，单章也采用独立单本兼容入口。新版快应用接收旧插件消息时，只有唯一同名本地目标且本次文件完整才替换；同名歧义/文件失败时保留已有作品。旧消息替换新版作品后会清除旧物理引用、回收全部失效根。

## 控制协议

`hs_pong.caps.importChapterProtocol = 1` 与 `httpImport`、`importResultProtocol` 独立协商；没有原生 fetch 的设备也可以通过互联使用章节追加。

HTTP 任务详情与新版 `import_comic_header` 携带以下字段：

```json
{
  "importChapterProtocol": 1,
  "bookId": "book_stable_identity",
  "operation": "upsert_chapters",
  "targetComicId": "local_existing_id",
  "isSerial": true,
  "totalChapters": 5,
  "chapters": [
    { "chapterNum": 5, "title": "第五话", "pageCount": 20 }
  ]
}
```

- `operation`：`replace_book` 为整书替换，`upsert_chapters` 为所选章节追加/更新。
- `bookId`：稳定作品身份，区别于一次执行的 taskId/sessionId 和 HTTP 发布快照 comicId/revision。
- `targetComicId`：可选，明确指定设备条目；缺省时按 `bookId` 查找，新作品逻辑 ID 为 `local_<bookId>`。不存在/歧义/在线作品目标不回退名称匹配。
- HTTP 的 `chapters` 保持任务章节模型；标准 `/config`、详情、`title + images[]` 和图片参数流程继续复用。
- 稀疏或较大真实章号的 HTTP 自动下载只构建本次所选章节列表，不分配 `1..最大章号` 的完整网格。
- 互联保持 `mode/files/chapters[].name/chapters[].files` 与现有分片格式，并在章节项补充真实 `chapterNum/title/pageCount`。`name` 为 `<真实章号>　<规范化章名>`。设备校验目录、连续页码及唯一页号后才确认 header。
- 新版 header 重发返回原会话 ACK；ACK 按会话匹配。设备在 header 阶段拒绝时回传原 session 的失败结果，插件立即停止；新版 header 持续无确认时有界失败，不退化成未经确认的直接发片。

## 保存与失败保护

两条通道共用 `src/components/comicImport.js`：

1. 固定计划并核对作品身份、目标条目与真实章号，取得目标写入/删除占用。
2. 创建独立 `local_stage_*` 根目录，保护在途目录；HTTP 下载准备元数据只保留在本次事务内存中。
3. 使用原有逐页下载/move 或互联写盘。结束后检查声明的每页实际文件头与长度，封面不能是 LVGL。
4. 本次所选内容完整时，在 `comics.json` 的串行原子更新中核对目标内容版本，合并指定章或替换整书，保持目标逻辑 ID。
5. 索引提交后核对全量有效引用，清理失去引用的旧根/旧章。失败或取消保持旧索引和旧正文；原生写入仍在途时，保留占用与目录保护直到真实回调结束。

一次任务的所选章节作为一组提交。坏图、缺页或索引失败不会发布半个替换版本；首次新建失败也不会把暂存内容显示成已保存作品。原子索引写已提交时，取消需等待该写入结果结算；不能把已经被索引引用的新目录当作取消半成品删除。

## 索引与文件格式

逻辑作品 ID 和物理存储位置分开。`comics.json` 增加可选 `bookId/storageId/revision/coverMissing`，章节增加可选 `storageId`。例如：

```json
{
  "id": "local_book_stable_identity",
  "bookId": "book_stable_identity",
  "name": "作品名称",
  "is_serial": true,
  "storageId": "local_stage_first_version",
  "chapters": [
    { "num": 1, "name": "第一话", "page_count": 10, "downloaded": 10, "storageId": "local_stage_first_version" },
    { "num": 2, "name": "第二话", "page_count": 20, "downloaded": 20, "storageId": "local_stage_second_version" }
  ]
}
```

正文仍为 `1`/`1.bin`，封面仍为 `cover`，章节目录仍为 `<真实章号>　<规范化章名>`。没有存储引用的旧记录回退到原作品 ID 目录。

- 书架和阅读器按章节引用读取；保留原逻辑 ID 与真实章号历史，更新后较长的旧页码限制到新章范围。留栈阅读页再次显示时重新核对本地版本。
- 容量/页数扫描只扫描有效章节版本，迟到扫描不覆盖新版本的引用。
- 封面回传使用作品的实际封面根；单章更新保留旧封面。
- 删除覆盖作品的全部有效根；启动清理保护索引引用和在途根，并在删除孤儿目录前重查最新索引。

## 验证

自动化执行真实提交模块、HTTP 会话/下载页面、互联接收、书架映射与阅读脚本。插件实际 release WASM 验证真实 UI、选图、握手、任务详情、分片重组和旧端分流。

```text
node --test tools/test-comic-import.mjs tools/test-data-delete.mjs tools/test-download.mjs tools/test-data-bridge.mjs tools/test-interconnfetch.mjs tools/test-gateway.mjs tools/test-http-data-sync.mjs tools/test-download-executor.mjs
cargo test --locked --target x86_64-pc-windows-msvc
python scripts/build_dist.py --release --package --locked
cargo run --locked --manifest-path scripts/v4_runtime_check/Cargo.toml --target x86_64-pc-windows-msvc --target-dir target/v4-runtime-check -- dist/bandcomic_astrobox_v2_plugin.wasm
```

最后一条可追加 `--chapters-only` 调试本项矩阵。真机/宿主结果按 `todo.md` 的 V-114～V-121 分别记录，覆盖 9 Pro HTTP、10 Pro 互联与旧端兼容。

2026-10-04 交付：Node 八套 220/220、Rust Native 72/72、实际 release WASM 完整矩阵及最终产物章节子矩阵通过；ESLint 0 error（9 条既有 warning），debug/JSC-only release RPK 与 release ABP 构建完成。真机/宿主验收仍按上述 V 项记录。
