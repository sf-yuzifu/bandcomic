# 自定义漫画源配置指南

本文档说明腕上漫画自定义漫画源需要提供的配置、接口返回格式、图片参数规则，以及与 AstroBox 腕上漫画同步器插件配合时的同步要求。

## 1. 基本要求

自定义漫画源需要满足以下要求：

1. 必须支持 HTTPS / SSL。
2. 必须提供 `/config` 路由，用于输出漫画源配置。
3. 所有业务接口建议返回 UTF-8 JSON。
4. 图片 URL 必须能被快应用直接请求，或者由你的 API 代理后返回图片二进制。
5. 如果需要登录态，可以通过 Cookie 支持用户认证。

## 2. `/config` 配置接口

腕上漫画同步器会请求漫画源的 `/config` 路由，并将返回的配置同步到手表。

### 2.1 返回格式

```json5
{
  "sourceKey": {
    "name": "漫画源显示名称",
    "apiUrl": "https://your-api.example.com",
    "detailPath": "/album/<id>",
    "photoPath": "/photo/<id>/chapter/<chapter>",
    "searchPath": "/search/<text>/<page>",
    "type": "sourceType"
  }
}
```

### 2.2 字段说明

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `sourceKey` | 是 | 漫画源内部键名。Cookie、当前源选择等会使用它作为标识。 |
| `name` | 是 | 在腕上漫画主界面显示的漫画源名称。 |
| `apiUrl` | 是 | API 基础地址，必须是 HTTPS。不要以 `/` 结尾更稳妥。 |
| `detailPath` | 是 | 漫画详情接口路径，必须包含 `<id>` 占位符。 |
| `photoPath` | 是 | 漫画图片列表接口路径，必须包含 `<id>`，章节漫画还应包含 `<chapter>`。 |
| `searchPath` | 是 | 搜索接口路径，必须包含 `<text>` 和 `<page>`。 |
| `type` | 建议 | 漫画源类型标识，当前主要用于区分来源，可与 `sourceKey` 相同。 |

### 2.3 jmcomic API 示例

`vercel-flask-jmcomic-api` 的 `/config` 返回示例：

```json
{
  "JMComic": {
    "name": "JMComic",
    "apiUrl": "https://your-api.example.com",
    "detailPath": "/album/<id>",
    "photoPath": "/photo/<id>/chapter/<chapter>",
    "searchPath": "/search/<text>/<page>",
    "type": "jmcomic"
  }
}
```

## 3. 腕上漫画实际请求流程

### 3.1 ID 直达详情

当用户输入纯数字时，应用会请求：

```text
GET {apiUrl}{detailPath.replace("<id>", 用户输入ID)}
```

例如：

```text
GET https://your-api.example.com/album/114514
```

### 3.2 关键词搜索

当用户输入非纯数字内容时，应用会进入搜索页，请求：

```text
GET {apiUrl}{searchPath
  .replace("<text>", encodeURIComponent(keyword))
  .replace("<page>", page)}
```

例如：

```text
GET https://your-api.example.com/search/%E6%B5%8B%E8%AF%95/1
```

### 3.3 打开搜索结果

用户点击搜索结果后，会再次请求详情接口：

```text
GET {apiUrl}{detailPath.replace("<id>", comic_id)}
```

### 3.4 打开阅读页

阅读页会先请求图片列表：

```text
GET {apiUrl}{photoPath
  .replace("<id>", item_id)
  .replace("<chapter>", chapter)}
```

然后再逐页请求 `images[].url` 中的图片。

## 4. 请求头

所有 API 请求都会携带 `User-Agent`：

```text
User-Agent: packageName(versionName(versionCode))/product/brand/osType/osVersionName/osVersionCode/language/region
```

示例：

```text
User-Agent: moe.yzf.comic(1.8(114))/Xiaomi Smart Band 9 Pro/Vela/NuttX/10.3.0/656128/zh/CN
```

你可以根据其中的 `product` 判断设备型号，并针对设备性能返回不同尺寸或格式的图片。

如果用户通过同步器上传过 Cookie，请求还会携带：

```text
Cookie: cookie_value
```

Cookie 的存储格式为：

```json
{
  "sourceKey": "cookie_value"
}
```

其中 `sourceKey` 对应 `/config` 返回对象中的顶层键名，例如 `JMComic`。

## 5. 详情接口 `detailPath`

详情接口用于展示漫画基本信息，并作为进入阅读、下载的入口。

### 5.1 请求示例

```text
GET /album/114514
```

### 5.2 返回格式

```json5
{
  "item_id": 114514,
  "name": "comicName",
  "page_count": 24,
  "views": 1919810,
  "rate": 9.0,
  "cover": "https://your-api.example.com/album/114514/cover",
  "tags": ["tag1", "tag2"],
  "total_chapters": 1
}
```

### 5.3 字段说明

| 字段 | 必需 | 类型 | 说明 |
| --- | --- | --- | --- |
| `item_id` | 是 | number / string | 漫画 ID，后续阅读和下载会继续使用。 |
| `name` | 是 | string | 漫画名称。 |
| `page_count` | 是 | number | 页数。章节漫画可先返回当前源可获得的总页数或第一章页数，阅读页会根据图片列表重新更新。 |
| `cover` | 是 | string | 封面图片 URL。应用会自动追加封面图片参数。 |
| `views` | 否 | number / string | 浏览量。 |
| `rate` | 否 | number / string | 评分。 |
| `tags` | 否 | array | 标签数组。 |
| `total_chapters` | 否 | number | 总章节数。大于 1 时，应用按章节漫画处理。未提供时建议返回 `1`。 |

## 6. 搜索接口 `searchPath`

搜索接口用于返回分页搜索结果。

### 6.1 请求示例

```text
GET /search/keyword/1
```

`<text>` 会被腕上漫画使用 `encodeURIComponent` 编码。后端需要能处理 URL 编码后的中文关键词。

### 6.2 返回格式

```json5
{
  "page": 1,
  "has_more": true,
  "results": [
    {
      "comic_id": 114514,
      "title": "comicName",
      "cover_url": "https://your-api.example.com/album/114514/cover",
      "pages": 24
    }
  ]
}
```

### 6.3 字段说明

| 字段 | 必需 | 类型 | 说明 |
| --- | --- | --- | --- |
| `page` | 是 | number | 当前返回的页码。应用会用 `page + 1` 作为下一次请求页码。 |
| `has_more` | 是 | boolean | 是否还有下一页。 |
| `results` | 是 | array | 搜索结果数组。 |
| `results[].comic_id` | 是 | number / string | 漫画 ID，点击结果后会传给详情接口。 |
| `results[].title` | 是 | string | 漫画标题。 |
| `results[].cover_url` | 是 | string | 搜索结果封面 URL。应用会自动追加封面图片参数。 |
| `results[].pages` | 否 | number | 页数，用于搜索结果中展示。 |

## 7. 图片列表接口 `photoPath`

图片列表接口用于返回某个漫画或某个章节的所有图片 URL。

### 7.1 请求示例

```text
GET /photo/114514/chapter/1
```

### 7.2 返回格式

```json5
{
  "title": "chapterName",
  "images": [
    { "url": "https://your-api.example.com/image/proxy?url=https%3A%2F%2Fexample.com%2F1.jpg" },
    { "url": "https://your-api.example.com/image/proxy?url=https%3A%2F%2Fexample.com%2F2.jpg" }
  ]
}
```

### 7.3 字段说明

| 字段 | 必需 | 类型 | 说明 |
| --- | --- | --- | --- |
| `title` | 是 | string | 当前漫画或章节标题。 |
| `images` | 是 | array | 图片数组。 |
| `images[].url` | 是 | string | 图片 URL。应用会在真正请求图片时自动追加图片参数。 |

> 注意：`images[].url` 不需要提前拼好 `width`、`quality`、`ifPNG`、`ifLVGL`。腕上漫画会在请求图片文件时自动追加这些参数。

## 8. 图片 URL 参数规则

腕上漫画会对封面图和正文图片追加不同参数。

### 8.1 正文图片参数

阅读页和下载正文图片时，应用会追加：

```text
width=<设置里的图片尺寸>&quality=<设置里的图片质量>
```

如果用户开启“PNG图片解析”，还会追加：

```text
ifPNG=1
```

如果用户开启“图片预解码”，还会追加：

```text
ifLVGL=1
```

并且 URL 末尾会追加 fragment，用于本地临时文件识别：

```text
#<chapter>.bin
#<page>.bin
```

示例：

```text
https://your-api.example.com/image/proxy?url=xxx&width=600&quality=50&ifPNG=1&ifLVGL=1#1.bin
```

后端通常不会收到 `#1.bin`，因为 fragment 不会发送到服务器。它只用于客户端本地识别临时文件扩展名。

### 8.2 封面图片参数

搜索封面、详情封面、下载封面会追加：

```text
width=80&quality=<设置里的图片质量>
```

如果用户开启“PNG图片解析”，还会追加：

```text
ifPNG=1
```

封面不会追加：

```text
ifLVGL=1
```

也不会追加 `.bin`。

示例：

```text
https://your-api.example.com/album/114514/cover?width=80&quality=50&ifPNG=1
```

### 8.3 兼容旧参数名建议

当前腕上漫画会追加 `width`。如果你的旧接口使用 `w` 表示宽度，建议同时兼容：

```python
width = request.args.get("width") or request.args.get("w")
```

## 9. 图片接口建议行为

图片接口可以是正文图片直出接口，也可以是代理接口。推荐实现以下参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `width` | number | 目标宽度。正文图片默认可按 600 处理，封面会传 80。 |
| `quality` | number | 图片质量，范围建议 1-100。JPEG 可直接映射质量；PNG 可用于颜色量化。 |
| `ifPNG` | truthy | 为 `1`、`true`、`True`、`yes`、`on` 时返回 PNG。 |
| `ifLVGL` | truthy | 为 `1`、`true`、`True`、`yes`、`on` 时返回 LVGL 预解码二进制。 |

### 9.1 返回 JPEG

默认建议返回 JPEG：

```http
Content-Type: image/jpeg
```

### 9.2 返回 PNG

当 `ifPNG=1` 时返回 PNG：

```http
Content-Type: image/png
```

如果设备不支持 JPG 解码，用户可以开启“PNG图片解析”。小米手环 10 Pro 会自动开启该设置。

PNG 推荐处理方式：

1. 不改变图片尺寸，除非传入了 `width`。
2. 去掉透明通道，铺白底转 RGB。
3. 使用最高 PNG 压缩等级。
4. 可复用 `quality` 做颜色量化，以减小体积。

### 9.3 返回 LVGL 预解码二进制

当 `ifLVGL=1` 时，建议优先于 `ifPNG` 返回 LVGL 二进制：

```http
Content-Type: application/octet-stream
```

推荐优先级：

```text
ifLVGL=1 > ifPNG=1 > 默认 JPEG
```

也就是说，如果同时收到：

```text
ifPNG=1&ifLVGL=1
```

应返回 LVGL `.bin` 数据，而不是 PNG。

> 封面请求不会带 `ifLVGL`，所以封面接口不需要处理 LVGL 小巧思。

## 10. jmcomic API 图片接口参考

`vercel-flask-jmcomic-api` 中的 `/image/proxy` 是一个推荐参考实现。

### 10.1 代理图片请求

```text
GET /image/proxy?url=<image_url>&width=600&quality=50&ifPNG=1
```

处理逻辑：

1. 读取 `url` 参数，下载原图。
2. 读取 `width`，按宽度等比例缩放。
3. 读取 `quality`，控制 JPEG 质量或 PNG 量化。
4. 如果 `ifLVGL=1`，返回 LVGL 二进制。
5. 否则如果 `ifPNG=1`，返回 PNG。
6. 否则返回 JPEG。

### 10.2 章节图片列表

`/photo/<item_id>/chapter/<chapter>` 返回：

```json5
{
  "title": "chapterName",
  "images": [
    {
      "url": "https://your-api.example.com/image/proxy?url=https://your-api.example.com/photo/123/123_1.jpg"
    }
  ]
}
```

应用会在真正请求 `images[].url` 时追加 `width`、`quality` 等参数。

### 10.3 搜索结果

`/search/<keyword>/<page>` 返回：

```json5
{
  "page": 1,
  "has_more": true,
  "results": [
    {
      "comic_id": 114514,
      "title": "comicName",
      "cover_url": "https://your-api.example.com/album/114514/cover",
      "pages": 0
    }
  ]
}
```

### 10.4 详情信息

`/album/<item_id>` 返回：

```json5
{
  "item_id": 114514,
  "name": "comicName",
  "page_count": 24,
  "views": "1919810",
  "cover": "https://your-api.example.com/album/114514/cover",
  "tags": ["tag1", "tag2"],
  "total_chapters": 1
}
```

## 11. Cookie 支持

如果漫画源需要 Cookie 认证，用户可以通过 AstroBox 腕上漫画同步器上传 Cookie。

### 11.1 上传流程

1. 在 AstroBox 插件市场安装“腕上漫画同步器”。
2. 在电脑浏览器打开漫画源网站并登录。
3. 按 `F12` 打开开发者工具，进入 Network 标签。
4. 刷新页面，选择任意请求。
5. 从请求头复制 `Cookie` 字段。
6. 打开腕上漫画同步器，输入漫画源地址，例如：

```text
https://your-api.example.com
```

7. 插件会请求 `/config` 获取漫画源名称。
8. 粘贴 Cookie，点击同步到手表。

### 11.2 后端接收

腕上漫画请求接口时会自动带上：

```http
Cookie: cookie_value
```

后端按普通 HTTP Cookie 读取即可。

## 12. 错误返回建议

建议错误时返回 JSON，并使用合适 HTTP 状态码：

```json
{
  "code": 500,
  "message": "错误原因"
}
```

常见建议：

| 场景 | HTTP 状态码 | 返回 |
| --- | --- | --- |
| 漫画不存在 | 404 | `{ "code": 404, "message": "Comic not found" }` |
| 章节不存在 | 404 | `{ "code": 404, "message": "Chapter not found" }` |
| 缺少参数 | 400 | `{ "code": 400, "message": "Missing parameter" }` |
| 上游失败 | 502 / 500 | `{ "code": 500, "message": "Upstream failed" }` |

## 13. 最小可用 Flask 示例

```python
from flask import Flask, jsonify, request, Response

app = Flask(__name__)

@app.get("/config")
def config():
    api_url = request.host_url.rstrip("/")
    return jsonify({
        "Example": {
            "name": "Example",
            "apiUrl": api_url,
            "detailPath": "/album/<id>",
            "photoPath": "/photo/<id>/chapter/<chapter>",
            "searchPath": "/search/<text>/<page>",
            "type": "example"
        }
    })

@app.get("/album/<item_id>")
def album(item_id):
    api_url = request.host_url.rstrip("/")
    return jsonify({
        "item_id": item_id,
        "name": "Example Comic",
        "page_count": 2,
        "cover": f"{api_url}/cover/{item_id}",
        "tags": ["example"],
        "total_chapters": 1
    })

@app.get("/search/<keyword>/<int:page>")
def search(keyword, page):
    api_url = request.host_url.rstrip("/")
    return jsonify({
        "page": page,
        "has_more": False,
        "results": [{
            "comic_id": "1",
            "title": "Example Comic",
            "cover_url": f"{api_url}/cover/1",
            "pages": 2
        }]
    })

@app.get("/photo/<item_id>/chapter/<int:chapter>")
def photo_list(item_id, chapter):
    api_url = request.host_url.rstrip("/")
    return jsonify({
        "title": f"Chapter {chapter}",
        "images": [
            {"url": f"{api_url}/image/1"},
            {"url": f"{api_url}/image/2"}
        ]
    })
```

## 14. 部分可直接部署的漫画源源代码

> 鉴于大部分用户没有写代码的经历，以及个人原因无法保证所有漫画源长期可用，推荐用户搭建自己的自定义漫画源。
>
> 通常只需要一个 Vercel 账号和一个自己的域名即可。

### jmcomic API

<a href="https://github.com/sf-yuzifu/vercel-flask-jmcomic-api">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api" />
    <img alt="Repo Card" src="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api" />
  </picture>
</a>

### ehentai API

<a href="https://github.com/sf-yuzifu/vela-py-eh-api-server">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=vela-py-eh-api-server&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=vela-py-eh-api-server" />
    <img alt="Repo Card" src="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=vela-py-eh-api-server" />
  </picture>
</a>

## 15. 实验性功能：导入 Venera 漫画源

> 由于 [Venera 漫画源](https://github.com/venera-app/venera-configs) 通常通过 JS 解析 HTML 获取数据，不适合直接在腕上漫画内运行。
>
> 腕上漫画提供了实验性的转换方案，允许将 Venera 漫画源转换为腕上漫画可用的 HTTP API。

该方法需要用户拥有服务器和自定义域名，可参考以下仓库：

<a href="https://github.com/sf-yuzifu/venera-source-converter">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=venera-source-converter&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=venera-source-converter" />
    <img alt="Repo Card" src="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=venera-source-converter" />
  </picture>
</a>
