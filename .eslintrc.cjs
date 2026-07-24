module.exports = {
  root: true,
  env: {
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  globals: {
    global: "writable",
    console: "readonly",
    require: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    setInterval: "readonly",
    clearInterval: "readonly",
    URL: "readonly",
  },
  plugins: ["html"],
  settings: {
    "html/html-extensions": [".ux"],
    "html/indent": "0",
    "html/report-bad-indent": "off",
  },
  extends: "eslint:recommended",
  overrides: [
    {
      files: [".eslintrc.cjs"],
      env: { node: true },
      parserOptions: { sourceType: "script" },
    },
    {
      files: ["quickapp.config.js"],
      env: { node: true },
      parserOptions: { sourceType: "script" },
    },
    {
      files: ["tools/**/*.mjs"],
      env: { node: true },
      parserOptions: { sourceType: "module", ecmaVersion: 2022 },
    },
  ],
  rules: {
    "no-var": "error",
    "prefer-const": ["error", { destructuring: "all" }],
    eqeqeq: ["warn", "always", { null: "ignore" }],
    "no-unused-vars": [
      "warn",
      { args: "none", caughtErrors: "none", ignoreRestSiblings: true },
    ],
    "no-empty": ["warn", { allowEmptyCatch: true }],
    "no-irregular-whitespace": ["error", { skipTemplates: true }],
    "no-console": "off",
  },
};
