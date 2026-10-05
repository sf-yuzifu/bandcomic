# 腕上漫画技术与协议文档

欢迎查阅腕上漫画（BandComic）的技术文档库。本文档库包含了自定义漫画源开发、多源后端运行规范以及与 AstroBox 穿戴端插件互联通信的完整技术协议。

---

## 📑 文档索引导航

### 一、漫画源开发与部署规范

适合需要自建后端源、代理第三方图源或对接聚合服务的开发者：

| 文档 | 说明 | 适用场景 |
| :--- | :--- | :--- |
| 📖 [自定义漫画源接入指南](CUSTOM_SOURCE.md) | 包含 `/config` 规范、详情/搜索/图片接口协议、LVGL 预解码二进制参数及 Flask 示例。 | 自建/第三方漫画源开发 |
| ⚙️ [多源后端运行时规则](SOURCE_RUNTIME.md) | 多源独立部署、鉴权上下文 Token 隔离、重试退避冷却与正文串行流控策略。 | 后端架构与稳定性保障 |

### 二、AstroBox 协同与互联协议

腕上漫画快应用与手机/桌面端「腕上漫画同步器」插件之间的数据通道协议：

| 文档 | 说明 | 最低版本要求 |
| :--- | :--- | :--- |
| 🔄 [漫画源与 Cookie 同步指南](SOURCE_SYNC.md) | 通过互联通道批量下发 `/config` 目录条目与逐源安全 Cookie。 | 快应用 `vCode >= 318` |
| 📥 [本地章节追加与整书导入规范](LOCAL_CHAPTER_IMPORT.md) | 支持整本覆盖与基于真实章号的单章增量追加，双通道（HTTP + 分片互联）统一落盘校验。 | 快应用 `vCode >= 382` |
| 🖼️ [同步器图片成品处理规范](PLUGIN_IMAGE_PROCESSING.md) | 穿戴端图像成品渲染流水线（LVGL I8 预解码、PNG 透明、JPEG 压缩与缓存原子提交）。 | 同步器核心算法 |
| 🗑️ [设备书架单条删除协议](DATA_DELETE_PROTOCOL.md) | 基于唯一 ID/key 的精准删除请求、超时查询与结果闭环核验机制。 | 插件与快应用协同 |

---

## 💡 协议版本与能力协商矩阵

快应用与 AstroBox 插件建立连接时，会通过 `hs_ping` / `hs_pong` 动态协商支持的协议特性：

| 能力标识 (caps) | 对应协议文档 | 典型作用 |
| :--- | :--- | :--- |
| `importChapterProtocol: 1` | [LOCAL_CHAPTER_IMPORT.md](LOCAL_CHAPTER_IMPORT.md) | 本地多章节独立追加与更新 |
| `importResultProtocol: 1` | [LOCAL_CHAPTER_IMPORT.md](LOCAL_CHAPTER_IMPORT.md) | 导入写盘与索引写入结果闭环确认 |
| `deleteProtocol: 1` | [DATA_DELETE_PROTOCOL.md](DATA_DELETE_PROTOCOL.md) | 按 ID/Key 单条精准删除漫画或漫画源 |
| `httpImport: 1` | [LOCAL_CHAPTER_IMPORT.md](LOCAL_CHAPTER_IMPORT.md) | 本地回环 HTTP 高速直传通道 |
| `httpDataSync: 1` | [CUSTOM_SOURCE.md](CUSTOM_SOURCE.md) | 设备书架数据与封面通过 HTTP 高速回传 |
