<div align="center">
  <h1>腕上漫画</h1>
  <img src="src\common\logo.png" alt="腕上漫画" width="128">
</div>

## 重要声明

1. **开源性质**：本项目仅为开发者个人学习研究目的而开源，仅用于分享技术实现方案和学习经验，不包含任何实际内容资源

2. **责任豁免**：使用者因下载、使用、传播本项目而产生的任何法律责任、版权纠纷及经济损失等，均由其自身完全承担，与项目作者无关

3. **使用限制**：严禁任何个人或组织将本项目用于商业用途、非法传播或任何形式的盈利行为

4. **版权尊重**：请严格遵守相关法律法规，尊重内容创作者的知识产权，支持正版资源

**一旦使用本项目，即视为您已完全理解并同意以上声明内容**

## 已适配设备

目前已适配的小米手表/手环设备如下：

- **小米手环 9 Pro**
- **小米 Watch S3（蓝牙版/eSIM版）**
- **小米 Watch S4（蓝牙版/eSIM版）**
- **小米 Watch S4 Sport**
- **小米 Watch S4 41mm**
- **小米 Watch S4 eSIM 15周年纪念版**
- **Redmi Watch 5（蓝牙版/ESIM版）**
- **Redmi Watch 6**

> 注：其他型号设备因为缺失fetch功能而无法适配，若是有上述没有提到的设备但是自己确认设备支持fetch的可以尝试安装，但后果自负。

## 当前可用自定义漫画源
- ~~**jmcomic.yzf.moe**~~（额度满了不可用）
- ~~**eh-api.orpu.moe**~~（额度满了不可用）

## 关于配置自定义漫画源要求
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

3. 漫画源对应路由需要满足以下输出规则
   
- **detailPath**

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

- **photoPath**

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

- **searchPath**

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

- **附加内容**
  
> 在1.6(50)版本中新增了调整图片尺寸大小和质量的功能，目前做法是在`photoPath`-`images`的每个`url`中添加`width`和`quality`两个参数，所以你提供的URL地址最好是有这个功能的。

## 如何快速搭建可用的自定义漫画源
> 鉴于大部分用户没有写代码的经历，由于个人原因无法保证所有的漫画源可用（不要让我倒贴钱维护服务器😭）
> 
> 在这里优先推荐各位用户搭建自己的自定义漫画源
>
> 搭建方法非常简单，只需要一个Vercel账号以及一个自己的域名即可

选择下面可用的仓库按照指引部署即可快速搭建好可用的漫画源，不过其中的域名是无法访问的，需要搜索Vercel如何绑定自定义域名才可以使用

<a href="https://github.com/sf-yuzifu/vercel-flask-jmcomic-api">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api" />
    <img alt="Repo Card" src="https://github-readme-stats.vercel.app/api/pin/?username=sf-yuzifu&repo=vercel-flask-jmcomic-api" />
  </picture>
</a>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/sf-yuzifu/vercel-flask-jmcomic-api)

<a href="https://github.com/OrPudding/vela-py-eh-api-server">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=OrPudding&repo=vela-py-eh-api-server&theme=radical" />
    <source media="(prefers-color-scheme: light)" srcset="https://github-readme-stats.vercel.app/api/pin/?username=OrPudding&repo=vela-py-eh-api-server" />
    <img alt="Repo Card" src="https://github-readme-stats.vercel.app/api/pin/?username=OrPudding&repo=vela-py-eh-api-server" />
  </picture>
</a>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/OrPudding/vela-py-eh-api-server)

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

## 了解更多

你可以通过小米快应用的[官方文档](https://iot.mi.com/vela/quickapp)熟悉和了解快应用开发。

---

**注意**：请遵守相关法律法规，合理使用本项目。如有版权问题，请及时联系处理。
