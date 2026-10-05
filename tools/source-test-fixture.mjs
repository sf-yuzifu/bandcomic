// Complete source contracts for UI fixtures; production validation remains real.
import fs from "node:fs";
import nativeVm from "node:vm";
const code = (name) => fs.readFileSync(new URL("../src/components/" + name + ".js", import.meta.url), "utf8").replace(/^export /gm, "");
export function sourceFixture(source = {}) {
  return { name: "Fixture", apiUrl: "https://source.test", detailPath: "/album/<id>",
    photoPath: "/photo/<id>/<chapter>", searchPath: "/search/<text>/<page>", ...source };
}
export function installSourceFixture(global) {
  if (!global) return;
  global.userAgent = global.userAgent || (() => "TestUA");
  if (global.API_SETTING) Object.keys(global.API_SETTING).forEach((key) => {
    if (key !== "using" && global.API_SETTING[key] && typeof global.API_SETTING[key] === "object") {
      global.API_SETTING[key] = sourceFixture(global.API_SETTING[key]);
    }
  });
  if (!global.$api) return;
  const api = global.$api;
  api.getSourceContext = api.getSourceContext || (() => {
    const key = global.API_SETTING?.using || "source";
    return { key, source: sourceFixture(global.API_SETTING?.[key]), header: { "User-Agent": global.userAgent(),
      ...(global.cookie?.[key] ? { Cookie: global.cookie[key] } : {}) } };
  });
  api.saveSourceContext = api.saveSourceContext || (() => "fixture-token");
  api.isHttpSuccess = api.isHttpSuccess || ((response) => !!response && (!response.code || response.code < 400));
  api.formatApiError = api.formatApiError || ((data, code) => ({ formatted: String(data || code || "error") }));
}
export function createSourceFixtureContext(sandbox, ...options) {
  installSourceFixture(sandbox.global);
  const context = nativeVm.createContext(sandbox, ...options);
  nativeVm.runInContext(code("sourceConfig") + "\n" + code("httpResponse"), context);
  return context;
}
