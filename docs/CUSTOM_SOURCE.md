# 自定义漫画源配置指南

## 关于配置自定义漫画源要求

### 1. 基本要求

1. 漫画源必须要支持SSL协议
2. 漫画源必须要在 `/config` 路由输出以下的配置文件

```json5
{
  "sourceName":{ // 漫画源名称
    "name":"sourceName", // 漫画源名称（这行为主界面显示的名称）
    "apiUrl":"https://youapi.domain", // 漫画源地址
    "detailPath":"/comic/<id>", // 漫画源详情API，<id>为漫画ID
    "photoPath":"/photo/<id>/chapter/<chapter>", // 漫画源获取漫画图片API，<id>为漫画ID，<chapter>为第几章
    "searchPath":"/search/<text>/<page>", // 漫画源搜索API，<text>为搜索关键词，<page>为搜索的第几页
    "type":"sourceType" // 漫画源名称
  }
}
```

### 2. API路由输出规则

#### detailPath

获取漫画详情信息，用于在详情页显示漫画的基本信息。

```json5
{
  "item_id": 114514, // 漫画ID（必需）
  "name": "comicName", // 漫画名称（必需）
  "page_count": 24, // 漫画页数（必需）
  "views": 1919810, // 漫画浏览量（可选）
  "rate": 9.0, // 漫画评分（可选）
  "cover": "https://youapicover.domain", // 漫画封面（必需）
  "tags": ["tag1", "tag2"], // 漫画标签数组（可选）
  "total_chapters": 10 // 总章节数（可选，用于章节漫画）
}
```

#### photoPath

获取指定章节的图片列表，用于在阅读页面显示漫画内容。

> 在1.6(50)版本中新增了调整图片尺寸大小和质量的功能，目前做法是在`images`的每个`url`中添加`width`和`quality`两个参数，所以你提供的URL地址最好是有这个功能的。

```json5
{
  "title": "comicName", // 漫画名称（必需）
  "images": [ // 图片数组（必需）
    {"url": "https://youapiphoto1.domain?width=600&quality=50"},
    {"url": "https://youapiphoto2.domain?width=600&quality=50"}
  ]
}
```

#### searchPath

搜索漫画，返回搜索结果列表。

```json5
{
  "page": 1, // 当前页数（必需）
  "has_more": true, // 后面是否还有更多页数（必需）
  "results": [ // 搜索结果数组（必需）
    {
      "comic_id": 114514, // 漫画ID（必需）
      "title": "comicName", // 漫画名称（必需）
      "cover_url": "https://youapicover.domain", // 漫画封面（必需，宽要控制在200以内，不然手环会炸掉）
      "pages": 24 // 页数（可选，用于在搜索结果中显示）
    }
  ]
}
```

### 3. 请求头说明（1.8版本添加）

所有API请求都会携带以下请求头：

```
User-Agent: packageName(versionName(versionCode))/product/brand/osType/osVersionName/osVersionCode/language/region
```

例如：
```
User-Agent: moe.yzf.comic(1.8(114))/Xiaomi Smart Band 9 Pro/Vela/NuttX/10.3.0/656128/zh/CN
```

你可以根据这个请求头来判断用户使用的是哪个设备，从而根据设备的性能来调整图片的尺寸和质量。

### 4. Cookie支持（1.8版本添加）

如果漫画源需要Cookie认证，用户可以通过设备互联功能上传Cookie。Cookie会以JSON格式存储，格式如下：

```json5
{
  "sourceName": "cookie_value"
}
```

其中 `sourceName` 对应配置文件中的漫画源名称。请求时会自动添加 `Cookie` 请求头。

#### 如何使用 腕上漫画同步器 插件上传 Cookie

我们提供了 **腕上漫画同步器** 插件来简化 Cookie 的上传流程：

1. **安装插件**
   - 在 AstroBox 的插件市场中搜索并安装 **腕上漫画同步器** 插件

2. **获取 Cookie**

   > 这里不同漫画源对Cookie的要求不同，最好按照对应漫画源的要求来获取Cookie，在这里写一般通用的情况

   - 在电脑浏览器中打开你的漫画源网站
   - 登录账号（如果需要）
   - 按 `F12` 打开开发者工具 → 切换到 **Network（网络）** 标签
   - 刷新页面，点击任意一个请求
   - 在请求头中找到 `Cookie` 字段，复制其值

3. **使用插件上传**
   - 打开 AstroBox 的 **腕上漫画同步器** 插件
   - **漫画源域名**：输入你的漫画源地址，例如 `https://youapi.domain`
   - 插件会自动获取漫画源名称并显示在**漫画源名称**字段
   - **Cookie**：粘贴从浏览器复制的 Cookie 值
   - 点击**同步到手表**按钮

4. **完成**
   - 插件会自动将 Cookie 发送到手表上的腕上漫画应用
   - 之后访问该漫画源时，请求会自动携带 Cookie

## 部分可直接拿来部署的漫画源源代码

> 鉴于大部分用户没有写代码的经历，以及个人原因无法保证所有的漫画源可用（不要让我倒贴钱维护服务器😭）
> 
> 在这里优先推荐各位用户搭建自己的自定义漫画源
>
> 搭建方法非常简单，只需要一个Vercel账号以及一个自己的域名即可

选择下面可用的仓库或者翻阅作者别的仓库，按照指引部署即可快速搭建好可用的漫画源，不过其中的域名是无法访问的，需要搜索Vercel如何绑定自定义域名才可以使用

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

## （实验性功能）导入[Venera漫画源](https://github.com/venera-app/venera)

> 由于[Venera的漫画源](https://github.com/venera-app/venera-configs)是通过导入JS通过解析HTML来获取的，不适用于腕上漫画
> 
> 但由于腕上漫画的漫画源及其稀少，因此，我们提供了一个实验性功能，允许用户导入Venera的漫画源

这个方法暂时需要用户必须有一台服务器，以及自定义域名才能使用，可以通过下面的仓库来尝试部署

<a href="https://github.com/sf-yuzifu/venera-source-converter">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=venera-source-converter&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=venera-source-converter" />
    <img alt="Repo Card" src="https://stats.yuzifu.top/api/pin/?username=sf-yuzifu&repo=venera-source-converter" />
  </picture>
</a>
