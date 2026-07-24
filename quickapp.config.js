let TerserPlugin;
try {
  TerserPlugin = require("terser-webpack-plugin");
} catch (e) {
  TerserPlugin = null;
}

module.exports = {
  postHook: (config) => {
    if (config.mode === "production" && TerserPlugin) {
      config.optimization.minimize = true;
      config.optimization.minimizer = [
        new TerserPlugin({
          terserOptions: {
            compress: {
              pure_funcs: ["console.debug"],
            },
          },
        }),
      ];
    }
  },
};
