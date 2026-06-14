<div align="center">
   <br>
   <img src="docs/preview.png" alt="腕上漫画" >

   <br>
   <a href='https://gitee.com/sf-yuzifu/bandcomic/stargazers'><img src='https://gitee.com/sf-yuzifu/bandcomic/badge/star.svg?theme=white' alt='Gitee stars' /></a>
   <a href='https://gitee.com/sf-yuzifu/bandcomic/members'><img src='https://gitee.com/sf-yuzifu/bandcomic/badge/fork.svg?theme=white' alt='Gitee forks' /></a>
   <a href='https://github.com/sf-yuzifu/bandcomic/stargazers'><img alt="GitHub stars" src="https://img.shields.io/github/stars/sf-yuzifu/bandcomic?style=social"></a>
   <a href='https://github.com/sf-yuzifu/bandcomic/forks'><img alt="GitHub forks" src="https://img.shields.io/github/forks/sf-yuzifu/bandcomic?style=social"></a>
</div>

## 项目简介

腕上漫画是一个面向小米 Vela OS 手环/手表的漫画阅读工具，提供在线搜索、在线阅读、离线下载、自定义漫画源和 AstroBox 插件联动能力。

本项目本身不提供任何漫画内容，所有内容均来自用户自行配置的 API 漫画源。

## 主要特性

- **基于 Vela OS 开发**：适配小米手环 9/10 Pro、小米 Watch S3/S4/S5、Redmi Watch 5/6 等设备。
- **在线阅读**：支持通过自定义漫画源搜索漫画、查看详情并在线阅读。
- **离线下载**：支持将漫画下载到设备本地，在无网络环境下阅读。
- **自定义漫画源**：通过 `/config` 配置接口接入第三方或自建 API 漫画源。
- **图片参数调节**：支持设置图片宽度、质量、搜索封面显示等选项。
- **PNG 图片解析**：针对部分不支持 JPG 解析的新设备，可请求 API 返回 PNG 图片；小米手环 10 Pro 会自动启用该设置。
- **图片预解码**：支持请求 API 返回 LVGL 预解码 `.bin` 图片，提升部分低配置设备浏览流畅度。
- **AstroBox 插件联动**：支持通过 AstroBox 进行网络桥接、漫画源同步、Cookie 上传和本地漫画管理。
- **多端 UI 适配**：适配方屏、圆屏、小屏手环和不同分辨率手表。

## 使用说明

### 1. 普通设备

如果设备支持快应用 `fetch` 能力，可以直接在腕上漫画中：

1. 输入漫画 ID 或关键词。
2. 搜索并进入漫画详情。
3. 在线阅读或下载到本地。

### 2. 不支持 `fetch` 的设备

部分新设备缺少快应用 `fetch` 能力，需要通过 AstroBox 插件进行网络桥接。

典型设备：

- 小米手环 10 Pro

使用方式：

1. 在 AstroBox 中安装 `网桥 FetchBridge` 插件。
2. 在 FetchBridge 中监听应用包名：

```text
moe.yzf.comic
```

3. 保持 AstroBox 与设备连接。
4. 打开腕上漫画使用在线搜索、阅读、下载等功能。

### 3. 小米手环 10 Pro 说明

小米手环 10 Pro 存在两类兼容问题：

1. 设备不支持快应用原生 `fetch`，在线功能需要通过 AstroBox 的 `网桥 FetchBridge` 插件完成。
2. 部分固件环境下 JPG 图片解析存在兼容问题，因此腕上漫画会在检测到设备为 `Xiaomi Smart Band 10 Pro` 时自动开启“PNG图片解析”。

如果你使用的是小米手环 10 Pro，建议保持“PNG图片解析”开启。

## AstroBox 插件能力

本项目与 AstroBox 配合可以获得更多扩展能力。

### 网桥 FetchBridge

用于给不支持快应用 `fetch` 的设备提供网络请求能力。

- 插件名称：`网桥 FetchBridge`
- 监听包名：`moe.yzf.comic`
- 适用场景：小米手环 10 Pro 等缺少 `fetch` 能力的设备

### 腕上漫画同步器

用于管理腕上漫画的数据同步。

支持能力：

- 同步漫画源配置
- 上传漫画源 Cookie
- 管理本地漫画
- 删除本地漫画
- 删除漫画源
- 将漫画文件导入设备

## 自定义漫画源

本项目支持配置自定义漫画源。漫画源需要提供：

- `/config` 配置接口
- 漫画详情接口
- 搜索接口
- 图片列表接口
- 可直接请求或可代理处理的图片 URL

图片接口建议支持以下参数：

| 参数 | 说明 |
|------|------|
| `width` | 图片目标宽度 |
| `quality` | 图片质量 |
| `ifPNG=1` | 请求返回 PNG 图片 |
| `ifLVGL=1` | 请求返回 LVGL 预解码二进制 |

封面图片会固定请求 `width=80`，质量跟随应用设置，不会携带 `ifLVGL`。

详细接入方式见：[自定义漫画源配置指南](docs/CUSTOM_SOURCE.md)。

## 图片处理说明

腕上漫画会根据用户设置自动给图片 URL 添加参数。

### 正文图片

正文图片会追加：

```text
width=<图片尺寸>&quality=<图片质量>
```

开启 PNG 图片解析后追加：

```text
ifPNG=1
```

开启图片预解码后追加：

```text
ifLVGL=1
```

并在本地使用 `.bin` 文件保存预解码图片。

### 封面图片

封面图片会追加：

```text
width=80&quality=<图片质量>
```

开启 PNG 图片解析后追加：

```text
ifPNG=1
```

封面不会追加 `ifLVGL`，也不会保存为 `.bin`。

## 社区支持

本项目由 [`米坛社区开源项目支持计划`](https://www.bandbbs.cn/resources/4859/) 提供支持。

<a href="https://www.bandbbs.cn/resources/4859/"><img src="docs/badge.png" height="46"></a>

本项目由 [`AstroBox`](https://astrobox.online/open?source=resv2&id=moe.yzf.comic&provider=OfficialV2) 提供技术支持。

<a href="https://astrobox.online/open?source=resv2&id=moe.yzf.comic&provider=OfficialV2"><img height="46" src="https://astrobox.online/goab/zhcn/rounded/white.svg"></a>

## 数据说明

### 设备信息收集

本应用会读取以下设备信息用于生成 User-Agent，以便 API 服务器根据设备能力调整返回内容：

- 设备型号
- 设备品牌
- 操作系统类型和版本
- 语言和地区

User-Agent 格式：

```text
packageName(versionName(versionCode))/product/brand/osType/osVersionName/osVersionCode/language/region
```

重要说明：

- 这些信息仅用于 API 请求的 User-Agent 生成。
- 不会上传到任何非用户配置的第三方服务器。
- 不收集任何个人身份信息。

### 本地存储

本应用会在设备本地存储以下文件：

- `cookie.json`：用户输入的 API 认证 Cookie
- `settings.json`：用户的应用设置
- `history.json`：阅读历史记录
- `comics.json`：下载的漫画索引
- 下载的漫画文件：存储在 `internal://files/` 目录下
- `.bin` 文件：开启图片预解码后生成的本地预解码图片
- 临时图片文件：网络请求过程中生成，会在应用启动时自动清理

重要说明：

- 所有数据均存储在本地设备。
- 不会上传到任何服务器。
- 开发者无法访问用户设备上的数据。

## 已适配设备

### ✅ 完全适配

以下设备已完全适配，可连接 `小米运动健康` 正常使用绝大部分功能，并可以与 `AstroBox` 连接使用更多插件扩展功能：

| 设备 | 版本说明 |
|------|----------|
| **小米手环 9 Pro** | - |
| **小米 Watch S3** | 蓝牙版 / eSIM版 |
| **小米 Watch S4** | 蓝牙版 / eSIM版 |
| **小米 Watch S4 Sport** | - |
| **小米 Watch S4 41mm** | - |
| **小米 Watch S4 eSIM** | 15周年纪念版 |
| **小米 Watch S5 46mm** | 蓝牙版 / eSIM版 |
| **Redmi Watch 5** | 蓝牙版 / eSIM版 |
| **Redmi Watch 6** | - |

### ⚠️ 部分支持

| 设备 | 说明 |
|------|------|
| **小米手环 10 Pro** | 设备不支持快应用原生 `fetch`，在线功能需要通过 AstroBox 的 `网桥 FetchBridge` 插件连接使用；同时推荐保持“PNG图片解析”开启。 |

小米手环 10 Pro 使用在线功能时，需要安装 AstroBox 中的 `网桥 FetchBridge` 插件，并监听：

```text
moe.yzf.comic
```

### ❌ 不支持

以下设备不支持且暂无适配计划，主要原因是屏幕分辨率过小、设备能力不足或 AstroBox 不支持连接：

- 小米手环 9 / 小米手环 10
- 小米手环 8 Pro
- Redmi Watch 4
- 任何非 Vela OS 设备

> 注意：其他未列出的设备可能因缺失 `fetch` 功能而无法使用。如确认设备支持 `fetch`，可尝试安装，但后果自负。

## 快速上手

### 1. 开发环境搭建

```bash
# 安装依赖
yarn install

# 启动开发服务器
yarn run start
```

### 2. 项目构建

```bash
# 构建项目
yarn run build

# 发布版本
yarn run release
```

### 3. 调试模式

```bash
# 监听文件变化并自动重新构建
yarn run watch
```

## 技术栈

本应用基于以下技术栈开发：

- **操作系统**：小米 Vela OS
- **开发框架**：小米快应用框架
- **插件联动**：AstroBox

重要说明：

- 本应用不包含任何第三方内容。
- 所有内容由用户自行配置的 API 提供。
- 本应用仅作为阅读工具使用。

## License

本项目基于 [AGPL-3.0 License](https://www.gnu.org/licenses/agpl-3.0.html) 开源，请遵守相关协议规定。

### 开源协议说明

AGPL-3.0 协议意味着：

- 您可以自由使用、修改和分发本应用。
- 如果您修改了本应用并在网络服务器上运行，需要开源您的修改。
- 请保留原始版权声明和许可证信息。

## 免责声明

1. **项目性质**：本应用仅为开源技术工具，不提供任何漫画内容。

2. **用户责任**：
   - 用户需自行输入 API 地址，并对其合法性负责。
   - 用户应遵守当地法律法规，尊重内容创作者的知识产权。
   - 建议用户仅使用合法授权的 API 服务。

3. **数据安全**：
   - 所有数据存储在用户设备，开发者无法访问。
   - 不进行任何数据上传或收集。

4. **技术支持**：
   - 本应用不提供任何内容，仅作为阅读工具使用。
   - 不对 API 提供的内容负责。

一旦使用本项目，即视为您已完全理解并同意以上声明内容。

## 了解更多

你可以通过小米快应用的[官方文档](https://iot.mi.com/vela/quickapp)熟悉和了解快应用开发。

---

**注意**：请遵守相关法律法规，合理使用本项目。如有版权问题，请及时联系处理。
