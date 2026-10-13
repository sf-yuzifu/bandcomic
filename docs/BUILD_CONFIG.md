# 私有配置与可选内置构建

默认的 `start`、`build`、`release` **不内置漫画源，也不配置在线更新地址**。
用户仍可在设备上手动添加源、通过 AstroBox 同步源，或使用离线书架和本地导入。

## 1. 本地文件

将根目录的 `private.config.example.json` 复制为 `private.config.json`，填写配置。
`private.config.json` 已加入 `.gitignore`，放在 `src` 外，不会作为资源文件打包。

```json
{
  "sources": {
    "Example": {
      "name": "示例源",
      "apiUrl": "https://api.example.com",
      "detailPath": "/album/<id>",
      "photoPath": "/photo/<id>/chapter/<chapter>",
      "searchPath": "/search/<text>/<page>",
      "type": "example"
    }
  },
  "defaultSource": "Example",
  "updateCheckUrl": "https://updates.example.com/update.json"
}
```

- `sources`：源目录，字段规范见 [自定义源指南](CUSTOM_SOURCE.md)。支持多个源。
- `defaultSource`：默认源的 key；留空时使用目录中的第一个源。
- `updateCheckUrl`：在线更新 JSON 的 HTTP/HTTPS 地址，可包含查询参数。

仅开启一个功能时只校验、注入对应字段；未开启的字段不进入产物。
两者均关闭时，不读取私有文件，所以干净克隆无需创建该文件即可构建。
显式开启功能但对应配置缺失或无效时，构建失败，不会静默产生配置不完整的版本。

## 2. 独立打包开关

| 命令 | 内置源 | 更新地址 |
| --- | --- | --- |
| `yarn run release` | 无 | 无 |
| `yarn run release --with-builtin-sources` | 有 | 无 |
| `yarn run release --with-online-update` | 无 | 有 |
| `yarn run release --with-builtin-sources --with-online-update` | 有 | 有 |

`yarn run start`、`yarn run build` 支持同样的参数。也可使用
`--without-builtin-sources`、`--without-online-update` 显式关闭；同一功能的开关不能冲突。
原 toolkit 参数继续透传，例如 `yarn run build --with-online-update --mode production`。
发布构建继续默认启用 JSC，并在结束后恢复临时压缩的 i18n 源文件。

通过 Rspack `DefinePlugin` 注入的是已经按开关筛选的配置。直接使用原生 `aiot`
命令时也默认没有私有配置；需要开启功能请使用上述项目脚本。

**开启的地址会存在于生成的 RPK 中。`.gitignore` 只控制 Git 跟踪，不隐藏安装包内容。**

## 3. 更新发布数据

`docs/update.example.json` 是公开的更新响应模板，`downloadUrl` 留空。
真实响应放在根目录的 `private.update.json`（Git 忽略），并填写实际下载地址。
将该文件自行部署为 `updateCheckUrl` 指向的服务端 JSON；应用只打包检查地址，
更新版本信息、更新说明和下载二维码地址来自服务端响应。

这两个私有文件均不上传 Git，也不会被自动上传为 GitHub Release 附件。

## 4. GitHub Actions

推送版本标签触发的构建默认关闭两个私有功能。
手动运行 Release 工作流时可分别勾选 `with_builtin_sources` 和 `with_online_update`。
开启任一选项需要设置仓库 Secret **`BANDCOMIC_PRIVATE_CONFIG`**，内容为上述私有 JSON。
只发布 `dist/*.rpk`，配置文件不会作为附件上传。
