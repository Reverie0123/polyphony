import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compareSemver, detectInstallKind, Updater } from "../dist/updater.js";
import { tempDir } from "./helpers.mjs";

test("compareSemver", () => {
  assert.ok(compareSemver("0.2.0", "0.1.9") > 0);
  assert.ok(compareSemver("v1.0.0", "1.0.0") === 0);
  assert.ok(compareSemver("0.1.0-beta", "0.1.0") === 0);
  assert.ok(compareSemver("0.1.0", "0.1.1") < 0);
});

test("detectInstallKind from the app directory", () => {
  const { dir, cleanup } = tempDir();
  try {
    const setup = path.join(dir, "setup");
    mkdirSync(setup);
    writeFileSync(path.join(setup, "setup-install.json"), "{}");
    assert.equal(detectInstallKind(setup), "setup");
    const npx = path.join(dir, "_npx", "abc", "node_modules", "polyphony-chat");
    mkdirSync(npx, { recursive: true });
    assert.equal(detectInstallKind(npx), "npx");
    const glob = path.join(dir, "node_modules", "polyphony-chat");
    mkdirSync(glob, { recursive: true });
    assert.equal(detectInstallKind(glob), "global");
    const src = path.join(dir, "src-checkout");
    mkdirSync(path.join(src, "src"), { recursive: true });
    writeFileSync(path.join(src, "tsconfig.json"), "{}");
    assert.equal(detectInstallKind(src), "source");
  } finally {
    cleanup();
  }
});

test("Updater.check reports a newer version and falls back across registries", async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls++;
    if (String(url).includes("npmmirror")) throw new Error("mirror down");
    return { ok: true, json: async () => ({ version: "9.9.9" }) };
  };
  const u = new Updater("0.1.0", process.cwd(), fakeFetch);
  const info = await u.check();
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, "9.9.9");
  assert.equal(calls, 2);
  assert.ok(info.registry.includes("npmjs"));
  const down = new Updater("0.1.0", process.cwd(), async () => { throw new Error("offline"); });
  const bad = await down.check();
  assert.equal(bad.hasUpdate, false);
  assert.ok(bad.error);
});
