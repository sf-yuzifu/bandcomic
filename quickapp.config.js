// aiot-toolkit v2 使用 Rspack。私有文件位于 src 外，仅由构建入口按开关读取，
// DefinePlugin 注入已筛选的字段；直接运行 aiot 时也默认不包含私有配置。
const { DefinePlugin } = require("@rspack/core");
const buildConfig = process.env.BANDCOMIC_BUILD_CONFIG ||
  JSON.stringify({ sources: {}, defaultSource: "", updateCheckUrl: "" });

module.exports = {
  postHook(config) {
    config.plugins = config.plugins || [];
    config.plugins.push(new DefinePlugin({ __BANDCOMIC_BUILD_CONFIG__: buildConfig }));
  },
};
