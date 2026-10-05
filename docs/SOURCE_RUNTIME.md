# 八源运行规则更新

八个后端仓库继续独立部署，从各自 `/config` 导入。Venera 可返回多个源，因此
仓库数量不等于目录条目数量。现有 key、逐源 Cookie、历史和离线目录身份沿用。

配置必须含有效 `name/apiUrl/detailPath/photoPath/searchPath`，路径为单斜杠开头，
保留键/非法占位符/目录穿越被拒绝；可选 `idType` 为 numeric、uuid、gid_token、
slug 或 string。默认按源类型识别 MangaDex UUID、E-Hentai gid_token、拷贝 slug，
其余数字 ID。其他输入进入关键词搜索。

配置导入及健康检测为匿名请求，健康检测必须存在对应 key 的有效条目。
搜索→详情→封面→阅读/下载固定一份源配置和 Cookie 快照，路由只携带内存上下文
token，不把 Cookie 写入历史/路由/离线文件。同步新配置不改变正在处理的漫画身份。
上下文过期时需要重新打开漫画。

429/503 按 Retry-After 冷却该源，认证/不存在/参数错误不逐页连续重试。
正文仍串行下载，文件头校验、临时文件 move、JPEG/PNG 无扩展名与 LVGL `.bin`
命名保持原规则。公开稳定图片可以走 CDN，鉴权内容需要后端和 CDN 同时隔离。

自动化：`node --test tools/test-sources.mjs tools/test-download.mjs tools/test-photo.mjs
tools/test-download-executor.mjs tools/test-gateway.mjs tools/test-comic-import.mjs`。
真实 Vela 直连与 AstroBox 网桥的身份/图片验证仍需在设备上执行。
