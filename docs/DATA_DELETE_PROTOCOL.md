# 设备书架单条删除协议

> 协议版本标识：`deleteProtocol: 1`（研发代号：P1-43）

本协议用于 AstroBox 同步器请求腕上漫画删除设备本地漫画或自定义漫画源。控制请求和结果均使用 Interconnect，独立于列表通过 HTTP 或互联回传的选择；不要求设备支持原生 fetch。

## 能力与身份

- 插件 `hs_ping.caps` 与快应用 `hs_pong.caps` 声明 `deleteProtocol: 1`。插件仅在接受目标设备本次握手后启用新协议；未声明能力的旧端继续使用原名称命令。
- 漫画使用 `request_data` 回传的完整本地 `comic.id`，包含来源前缀，例如 `MangaDex_123` 或 `local_*`，同时也是设备目录名。
- 漫画源条目新增 `key`，取 `sources.json` 单键对象的配置 key。HTTP 与互联回传均携带 `key/name/apiUrl`，旧字段仍保留。
- 名称用于展示，不用于新版删除定位。缺少身份、ID/key 不唯一或目标不存在时拒绝；不回退寻找同名条目。漫画 ID 不接受路径分隔符、控制字符或 `.`/`..`；`using` 是源配置保留键。

## 删除请求

```json
{
  "type": "delete_item",
  "protocol": 1,
  "session": "hs123456789",
  "requestId": "del_123456789_1",
  "kind": "comic",
  "comicId": "MangaDex_123",
  "name": "漫画名称"
}
```

删除源时 `kind` 为 `source`，身份字段为 `sourceKey`，例如 `"sourceKey": "MySource"`。`session` 是本次已完成的握手 ID，不能使用列表的同步 session。`requestId` 由插件运行标识和递增序号组成，长度 ≤128，仅包含字母、数字、下划线或连字符；目标 ID/key 长度 ≤512。

插件在发送前登记请求，固定原设备名称/地址、握手 session、列表 revision 和条目身份。发送完成只表示传输调用结束，条目继续保留，等待设备实际结果。结果等待期为 20 秒，定时器核对请求及等待代际和真实截止时间。

## 设备结果

```json
{
  "type": "delete_result",
  "protocol": 1,
  "session": "hs123456789",
  "requestId": "del_123456789_1",
  "kind": "comic",
  "comicId": "MangaDex_123",
  "status": "partial",
  "filesState": "removed",
  "indexState": "retained",
  "code": "INDEX_WRITE_FAILED",
  "message": "文件已删除，但索引更新失败"
}
```

| 字段 | 语义 |
| --- | --- |
| `session/requestId/kind/comicId或sourceKey` | 回显原删除请求身份；结果查询也回显原请求的 session |
| `status` | `success` 实际完成；`failed` 未完成；`partial` 已知部分操作完成；`unknown` 无法确认；`processing` 原请求仍在执行 |
| `filesState` | `removed` 已删除；`missing` 明确不存在；`unknown` 无法确认；源删除为 `not_applicable` |
| `indexState` | `removed` 索引/配置已提交删除；`retained` 保留条目；`unknown` 无法确认 |
| `code/message` | 机器可识别原因及展示说明；I/O 错误可另带 `ioCode` |

漫画执行：严格读取索引并核对唯一 ID → 删除该目录或明确确认不存在 → 在存储队列中重新核对捕获条目并提交索引删除 → 缓存并回传结果。

- 访问目录或 `rmdir` 失败保留索引；普通 I/O 失败不能当作目录不存在。`rmdir` 失败时文件实际情况可能未知。
- 文件已删除而索引提交失败为 `partial`，保留索引供重试；目录已不存在时，重试仍须完成索引提交才能成功。
- 删除与同目标下载使用共享占用；退出后尚未完成的原生 mkdir/delete/move 和索引写入继续保留占用，直到自己的回调结束。
- 设备书架页面复用同一执行层，保留逐文件删除兜底；迟到的书架扫描仅更新仍存在的索引条目。

源执行：按 key 提交 `sources.json` 删除 → 清理对应内存配置 → 修正 `using` 指针 → 回传结果。删除自定义配置继续沿用内置源兜底规则；不联动清除已下载漫画、历史或 Cookie。

## 去重与结果查询

同一个 requestId 固定原 session、类型和目标。执行中重复请求返回 `processing`，不再次启动；完成后的重复请求重报原结果；同 ID 携带不同目标拒绝。设备保留最多 32 条记录，当前会话的身份和在途请求不被淘汰；空间不足时拒绝新执行，旧会话完成记录可在新握手后回收。

最终结果发送丢失时，插件在新握手后查询原请求：

```json
{
  "type": "delete_status",
  "protocol": 1,
  "session": "hs987654321",
  "requestSession": "hs123456789",
  "requestId": "del_123456789_1",
  "kind": "comic",
  "comicId": "MangaDex_123"
}
```

`session` 是查询所用当前握手，`requestSession` 是原删除握手；查询响应的 `session` 仍为原删除握手。查询不执行删除。记录不存在、快应用重启、查询会话失效或查询本身异常时，显示结果未知，通过重新读取完整列表核实；不能把查询失败当作原删除失败。

记录为本次快应用运行内的有界内存数据，不承诺跨重启持久化的严格去重。没有记录的旧会话执行消息会拒绝；插件不自动重放旧执行请求。明确失败/部分失败后的用户重试生成新的 requestId。

## 插件列表与兼容语义

- 删除状态独立于临时同步提示，持续显示准备、等待、查询、失败、部分失败、未知及设备确认完成。
- 收到匹配的成功结果，并核对文件状态及索引提交后，只更新仍有效的原设备/原代际快照；按 ID/key 移除，更新数量、封面统计及分页，推进列表代际使旧按钮失效。最近完整同步时间不因删除改变。
- 刷新期间及换设备后的迟到结果结算原请求，不直接调整新快照。页面提示重新读取核实。重复/其他请求/其他身份/已结束请求的结果不能重复减数。
- 超时、断连及发送异常保留条目，允许查询原结果或重新读取。当前设备未确认的请求先核实再继续删除，首版一次仅执行一条。
- 重新收到完整同设备列表时，可确认原条目仍在或列表已无该条目；“列表已无该条目”与设备直接确认文件删除完成分别展示。
- 旧端继续名称删除及同名拦截，显示“命令已发送，待刷新核实”。新快应用接收旧名称命令时要求唯一目标；源按 key/显示名合并判断候选，歧义时拒绝。

## 验证入口

快应用：`tools/test-data-delete.mjs`（真实删除/存储/去重控制器）、`tools/test-data-bridge.mjs`（真实互联分发及双通道元数据）、`tools/test-download.mjs`（原生迟到写入占用及下载回归）。

插件：`src/ui/deletion.rs` 的纯状态测试及 `scripts/v4_runtime_check` 的实际 release WASM UI/握手/定时器/HTTP/互联验证。构建及自动化通过后仍需安装到 AstroBox 和 9 Pro/10 Pro，按 P1-43 真机矩阵确认文件、索引和页面结果。
