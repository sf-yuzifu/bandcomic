<div align="center">
  <img src="docs/preview.png" alt="腕上漫画" >
  <br />
  <a href='https://gitee.com/sf-yuzifu/bandcomic/stargazers'><img src='https://gitee.com/sf-yuzifu/bandcomic/badge/star.svg?theme=white' alt='Gitee stars' /></a>
  <a href='https://gitee.com/sf-yuzifu/bandcomic/members'><img src='https://gitee.com/sf-yuzifu/bandcomic/badge/fork.svg?theme=white' alt='Gitee forks' /></a>
  <a href='https://github.com/sf-yuzifu/bandcomic/stargazers'><img alt="GitHub stars" src="https://img.shields.io/github/stars/sf-yuzifu/bandcomic?style=social"></a>
  <a href='https://github.com/sf-yuzifu/bandcomic/forks'><img alt="GitHub forks" src="https://img.shields.io/github/forks/sf-yuzifu/bandcomic?style=social"></a>

  <h3>面向小米 Vela OS 智能手环 / 手表的轻量级漫画阅读工具</h3>
</div>

---

## 📖 项目简介

**腕上漫画** 是一款运行在小米 Vela OS 穿戴设备上的快应用阅读工具，专为小屏与低功耗设备深度优化。支持在线搜索、在线追番、离线下载、本地传书与多语言界面。

> ⚠️ **声明**：本项目仅为纯客户端工具，**不内置、不提供、不抓取任何漫画内容**。所有数据均来自用户自行配置的第三方/自建 API 漫画源或本地导入。

---

## ✨ 核心特性

- **穿戴端定制阅读**：针对手环与手表屏幕（方屏/圆屏）专门布局，操作轻快流畅。
- **离线下载 & 书架**：支持单页容错逐页下载，无网环境离线阅读；按最近阅读智能排序。
- **性能与格式优化**：
  - **LVGL 预解码**：支持直接加载 `.bin` 格式预解码位图，大幅降低穿戴设备 CPU 渲染负担。
  - **动态尺寸与质量**：可自定义正文宽度、图片压缩质量及封面尺寸，兼顾画质与设备内存。
  - **PNG 兼容模式**：针对部分无法直接解析 JPG 的固件（如手环 10 Pro）自动/手动回退为 PNG。
- **自定义漫画源**：开放的标准 API 规范，通过 `/config` 接入任意自建或第三方漫画源。
- **AstroBox 强力联动**：配合 AstroBox 手机/电脑端，支持网桥代理、源与 Cookie 同步、双通道本地漫画极速导入。
- **国际化多语言**：支持简体中文、繁体中文（台/港）及英文，跟随设备系统语言自适应。

---

## ⌚ 设备适配状态

| 适配等级 | 设备型号 | 说明 |
| :--- | :--- | :--- |
| **✅ 完全适配** | **小米手环 9 Pro**<br>**小米 Watch S3 / S4 / S4 Sport / S4 41mm / S5**<br>**Redmi Watch 5 / 6** | 支持设备原生 `fetch` 直连，功能完整，可配合 AstroBox 插件使用高级拓展。 |
| **⚠️ 兼容运行** | **小米手环 10 Pro** | 固件缺少快应用原生 `fetch` 且部分固件不支持 JPG。需配合 AstroBox **FetchBridge 网桥** 使用，应用会自动启用“PNG解析”与“网桥优先”。 |
| **❌ 暂不支持** | 小米手环 9 / 10、小米手环 8 Pro、Redmi Watch 4 及非 Vela 系统设备 | 屏幕分辨率过低、系统能力受限或无快应用环境。 |

---

## 🚀 快速使用

### 1. 正常设备（支持原生网络）
1. 打开腕上漫画，在设置中配置漫画源（或通过 AstroBox 插件一键同步）。
2. 在搜索页输入漫画 ID 或关键词，点击即可在线阅读或下载至离线书架。

### 2. 小米手环 10 Pro（需网桥配合）
手环 10 Pro 固件未开放原生网络请求，需借助网桥插件中继：
1. 手机端打开 **AstroBox**，安装并启用插件 **`网桥 FetchBridge`**。
2. 在 FetchBridge 插件中监听应用包名：`moe.yzf.comic`。
3. 保持手环与 AstroBox 连接，打开腕上漫画即可正常联网。

---

## 🔌 配套生态与拓展能力

本项目与 [AstroBox 腕上漫画同步器插件](https://astrobox.online/open?source=resv2&id=moe.yzf.comic&provider=OfficialV2) 深度集成，提供桌面/手机端管理能力：

- **漫画源 & Cookie 同步**：批量拉取源配置，逐源配置/清空 Cookie，解决穿戴端输入繁琐的痛点。
- **本地漫画双通道导入**：
  - 支持将电脑/手机本地图片（单话/多章节/整本）导入手环。
  - 支持章节增量追加与覆盖，自动完成图片压缩与 LVGL 二进制转换。
  - 原生 HTTP 快速直传 + 互联分片双通道自适应回退。
- **设备书架远程管理**：在电脑端查看手环内已下载的漫画列表与封面，支持一键远程清理空间。

---

## 📚 开发与进阶文档

如需深入了解 API 对接规范、通信协议或二次开发，请参阅以下详细文档：

- 🌐 [自定义漫画源接入指南](docs/CUSTOM_SOURCE.md)：API 接口规范、参数要求与示例
- 🔄 [漫画源与 Cookie 同步说明](docs/SOURCE_SYNC.md)：同步器与快应用的配置同步机制
- 📥 [本地漫画与章节导入协议](docs/LOCAL_CHAPTER_IMPORT.md)：整书/单章增量导入及状态闭环规范
- 🖼️ [图片成品处理与预解码说明](docs/PLUGIN_IMAGE_PROCESSING.md)：LVGL I8、PNG、JPEG 压缩与缓存策略
- 🗑️ [设备书架删除协议](docs/DATA_DELETE_PROTOCOL.md)：双向确认与索引清理机制
- ⚙️ [多源运行时规则](docs/SOURCE_RUNTIME.md)：后端多源部署与鉴权规则

---

## 🛠️ 本地开发与构建

本项目使用小米 Vela 快应用工具链进行构建：

```bash
# 1. 安装项目依赖
yarn install

# 2. 启动开发服务器（支持热重载监听）
yarn run start

# 3. 生产环境构建
yarn run build

# 4. 发布打包（包含 JSC 优化）
yarn run release

# 5. 代码质量检查与格式化
yarn run lint
yarn run format
```

---

## 🔒 隐私与数据安全

- **纯本地存储**：漫画索引、历史记录、Cookie 及设置均保存在设备 `internal://files/` 本地沙盒中，不设云端同步，开发者无法获取任何数据。
- **User-Agent 说明**：仅向用户配置的 API 发送包含基础设备型号与系统的 UA 头，以便源服务器自适应下发适合该机型的图片尺寸。

---

## 📜 开源协议与免责声明

- 本项目采用 [AGPL-3.0 License](https://www.gnu.org/licenses/agpl-3.0.html) 协议开源。
- **免责声明**：本项目为开源工具，不提供任何版权内容。用户在使用自定义源时需自行确保源地址的合法性，并承担相关版权风险与法律责任。

---

## 🤝 致谢与支持

- 本项目由 [`米坛社区开源项目支持计划`](https://www.bandbbs.cn/resources/4859/) 提供支持。

<a href="https://www.bandbbs.cn/resources/4859/"><img src="docs/badge.png" height="46"></a>

- 本项目由 [`AstroBox`](https://astrobox.online/open?source=resv2&id=moe.yzf.comic&provider=OfficialV2) 提供技术支持。

<a href="https://astrobox.online/open?source=resv2&id=moe.yzf.comic&provider=OfficialV2"><img height="46" src="https://astrobox.online/goab/zhcn/rounded/white.svg"></a>
