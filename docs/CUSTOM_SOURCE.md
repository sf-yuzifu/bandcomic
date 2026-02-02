# 自定义漫画源配置指南

## 当前可用自定义漫画源
- ~~**example.invalid**~~（额度满了不可用）
- ~~**example.invalid**~~（额度满了不可用）

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

```json5
{
  "item_id": 114514, // 漫画ID
  "name": "comicName", // 漫画名称
  "page_count": 24, // 漫画页数
  "views": 1919810, // 漫画浏览量（可选）
  "rate": 9.0, // 漫画评分（可选）
  "cover": "https://youapicover.domain", // 漫画封面
  "tags": "", // 漫画标签（可选）
}
```

#### photoPath

```json5
{
  "title": "comicName", // 漫画名称
  // 漫画所有图片
  "images": [
    {"url": "https://youapiphoto1.domain?width=600&quality=50"},
    {"url": "https://youapiphoto2.domain?width=600&quality=50"}
  ]
}
```

#### searchPath

```json5
{
  "page": 1, // 当前页数
  "has_more": true, // 后面是否还有更多页数
  // 搜索结果
  "results": [
    {
      "comic_id": 114514, // 漫画ID
      "title": "comicName", // 漫画名称
      "cover_url": "https://youapicover.domain" // 漫画封面（宽要控制200以内，不然手环会炸掉）
    },
  ]
}
```

### 3. 附加内容

> 在1.6(50)版本中新增了调整图片尺寸大小和质量的功能，目前做法是在`photoPath`-`images`的每个`url`中添加`width`和`quality`两个参数，所以你提供的URL地址最好是有这个功能的。

## 如何快速搭建可用的自定义漫画源

> 鉴于大部分用户没有写代码的经历，由于个人原因无法保证所有的漫画源可用（不要让我倒贴钱维护服务器😭）
> 
> 在这里优先推荐各位用户搭建自己的自定义漫画源
>
> 搭建方法非常简单，只需要一个Vercel账号以及一个自己的域名即可

选择下面可用的仓库按照指引部署即可快速搭建好可用的漫画源，不过其中的域名是无法访问的，需要搜索Vercel如何绑定自定义域名才可以使用

### jmcomic API

<a href="https://github.com/sf-yuzifu/vercel-flask-jmcomic-api">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api" />
    <img alt="Repo Card" src="https://github-readme-stats.vercel.app/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api" />
  </picture>
</a>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/sf-yuzifu/vercel-flask-jmcomic-api)

### ehentai API

<a href="https://github.com/OrPudding/vela-py-eh-api-server">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=OrPudding&repo=vela-py-eh-api-server&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=OrPudding&repo=vela-py-eh-api-server" />
    <img alt="Repo Card" src="https://github-readme-stats.vercel.app/api/pin/?username=OrPudding&repo=vela-py-eh-api-server" />
  </picture>
</a>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/OrPudding/vela-py-eh-api-server)
