// aiot-toolkit v2 使用 Rspack 打包（非 webpack），release（--enable-jsc）构建
// 已验证会自动剥离全部 console.*（字节码中无残留），无需官方文档示例中的
// terser-webpack-plugin（该插件面向 webpack，在此工具链下无作用）。
// 本文件保留为空配置占位；toolkit 对缺失/空配置有兼容（CommonUtil.requireModule）。
module.exports = {};
