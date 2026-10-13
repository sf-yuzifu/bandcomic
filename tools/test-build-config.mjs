import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseBuildOptions, loadBuildConfig } from "./build-config.mjs";

function fixture(t, config) {
  const parent = path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "bandcomic-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "private.config.json");
  fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  return file;
}

const privateConfig = {
  sources: {
    A: {
      name: "A", apiUrl: "https://sources.example.test/", detailPath: "/album/<id>",
      photoPath: "/photo/<id>/<chapter>", searchPath: "/search/<text>/<page>", type: "example",
    },
  },
  defaultSource: "A",
  updateCheckUrl: "https://updates.example.test/update.json?channel=stable",
  unrelatedPrivateValue: "not-for-the-package",
};

test("build config: four feature combinations only inject selected private fields", (t) => {
  const file = fixture(t, privateConfig);
  for (const builtinSources of [false, true]) {
    for (const onlineUpdate of [false, true]) {
      const config = loadBuildConfig({ builtinSources, onlineUpdate }, file);
      assert.deepEqual(Object.keys(config).sort(), ["defaultSource", "sources", "updateCheckUrl"]);
      assert.equal(Object.keys(config.sources).length, builtinSources ? 1 : 0);
      assert.equal(config.defaultSource, builtinSources ? "A" : "");
      assert.equal(config.updateCheckUrl, onlineUpdate ? privateConfig.updateCheckUrl : "");
      if (builtinSources) assert.equal(config.sources.A.apiUrl, "https://sources.example.test");
      assert.ok(!JSON.stringify(config).includes("not-for-the-package"));
    }
  }
});

test("build config: public build ignores missing and malformed private files", (t) => {
  const options = parseBuildOptions([]);
  const file = fixture(t, "malformed private JSON");
  assert.deepEqual(loadBuildConfig(options, file), { sources: {}, defaultSource: "", updateCheckUrl: "" });
  fs.unlinkSync(file);
  assert.deepEqual(loadBuildConfig(options, file), { sources: {}, defaultSource: "", updateCheckUrl: "" });
  assert.throws(() => loadBuildConfig(parseBuildOptions(["--with-online-update"]), file), /无法读取/);
});

test("build config: invalid enabled fields fail, disabled fields are not validated", (t) => {
  const updateOnly = fixture(t, { sources: null, updateCheckUrl: privateConfig.updateCheckUrl });
  assert.equal(loadBuildConfig(parseBuildOptions(["--with-online-update"]), updateOnly).updateCheckUrl, privateConfig.updateCheckUrl);
  assert.throws(() => loadBuildConfig(parseBuildOptions(["--with-builtin-sources"]), updateOnly), /sources/);
  const sourcesOnly = fixture(t, { sources: privateConfig.sources, updateCheckUrl: "bad" });
  assert.equal(loadBuildConfig(parseBuildOptions(["--with-builtin-sources"]), sourcesOnly).defaultSource, "A");
  assert.throws(() => loadBuildConfig(parseBuildOptions(["--with-online-update"]), sourcesOnly), /updateCheckUrl/);
  const invalidSource = fixture(t, { sources: { A: { ...privateConfig.sources.A, searchPath: "/search" } } });
  assert.throws(() => loadBuildConfig(parseBuildOptions(["--with-builtin-sources"]), invalidSource), /searchPath/);
  const invalidDefault = fixture(t, { ...privateConfig, defaultSource: "missing" });
  assert.throws(() => loadBuildConfig(parseBuildOptions(["--with-builtin-sources"]), invalidDefault), /defaultSource/);
});

test("build config: private flags are consumed; toolkit flags pass through; conflicts fail", () => {
  assert.deepEqual(parseBuildOptions(["--with-builtin-sources", "--without-online-update", "--enable-jsc"]), {
    builtinSources: true, onlineUpdate: false, aiotArgs: ["--enable-jsc"],
  });
  assert.throws(() => parseBuildOptions(["--with-online-update", "--without-online-update"]), /同时/);
  assert.throws(() => parseBuildOptions(["--with-builtin-source"]), /未知/);
});
