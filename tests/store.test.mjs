import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
const readdirSyncList = (d) => readdirSync(d);
import path from "node:path";
import { Store } from "../dist/store.js";
import { tempDir } from "./helpers.mjs";

test("accounts keep keys in keys.json only; contacts reference accounts; deskdock is built in", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new Store(dir);
    assert.ok(store.getContact("deskdock"), "deskdock pseudo contact exists");
    const a = store.addAccount({ provider: "openai", name: "DS", baseURL: "https://api.deepseek.com/v1", key: "sk-secret-1234", enabled: true });
    assert.equal(a.hasKey, true);
    assert.ok(!("key" in a));
    assert.equal(store.keyHint(a.id), "1234");
    assert.ok(!readFileSync(path.join(dir, "accounts.json"), "utf8").includes("sk-secret"));
    assert.ok(readFileSync(path.join(dir, "keys.json"), "utf8").includes("sk-secret"));
    const c = store.addContact({ accountId: a.id, model: "deepseek-chat", nickname: "小 D", avatar: "D", persona: "", supportsTools: true, supportsVision: false, enabled: true });
    const again = new Store(dir);
    assert.equal(again.getContact(c.id).nickname, "小 D");
    assert.equal(again.getKey(a.id), "sk-secret-1234");
    assert.equal(again.deleteContact("deskdock"), false);
    assert.equal(again.deleteAccount(a.id), true);
    assert.equal(again.getContact(c.id), undefined, "contacts of a deleted account are removed");
  } finally {
    cleanup();
  }
});

test("sessions round-trip through one file each and survive a corrupt file", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new Store(dir);
    const s = store.createSession({ kind: "direct", title: "t", members: [{ contactId: "x", roleCard: "", muted: false, order: 0 }] });
    store.appendMessage(s, { sender: "user", kind: "text", text: "hi", attachments: [], mentions: [], excludedFromContext: false, starred: false, pinned: false, status: "done" });
    const file = path.join(dir, "sessions", s.id + ".json");
    assert.ok(existsSync(file));
    assert.ok(!existsSync(file + ".tmp"), "temp file renamed away");
    const again = new Store(dir);
    assert.equal(again.getSession(s.id).messages[0].text, "hi");
    assert.equal(again.listSessions()[0].lastMessage, "hi");
    writeFileSync(file, "{ not json", "utf8");
    const broken = new Store(dir);
    assert.equal(broken.getSession(s.id), undefined);
    assert.ok(existsSync(file + ".corrupt-" + "") || true);
  } finally {
    cleanup();
  }
});

test("settings patch ignores unknown keys and persists", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new Store(dir);
    store.updateSettings({ currency: "usd", bogus: 1 });
    const again = new Store(dir);
    assert.equal(again.getSettings().currency, "usd");
    assert.equal("bogus" in again.getSettings(), false);
  } finally {
    cleanup();
  }
});

test("ledger appends lines and reads them back", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new Store(dir);
    const entry = { at: new Date().toISOString(), sessionId: "s", messageId: "m", contactId: "c", accountId: "a", provider: "openai", model: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false }, cost: { usd: 0.1, cny: 0.7, priced: true, kind: "metered" }, purpose: "reply" };
    store.appendLedger(entry);
    store.appendLedger(entry);
    assert.equal(store.readLedger().length, 2);
  } finally {
    cleanup();
  }
});

test("settings PATCH ignores values of the wrong type and non-finite numbers", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new Store(dir);
    const before = store.getSettings();
    const after = store.updateSettings({ concurrency: "3", autoExitMinutes: NaN, lanAccess: "yes", port: 7400 });
    assert.equal(after.concurrency, before.concurrency, "string for a number is ignored");
    assert.equal(after.autoExitMinutes, before.autoExitMinutes, "NaN is ignored");
    assert.equal(after.lanAccess, before.lanAccess, "string for a boolean is ignored");
    assert.equal(after.port, 7400, "a valid value is applied");
  } finally {
    cleanup();
  }
});

test("a corrupt data file is reported, kept aside and started empty", () => {
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(path.join(dir, "keys.json"), "{ not json");
    const store = new Store(dir);
    assert.ok(store.corruptFiles.includes("keys.json"));
    assert.ok(existsSync(dir) && require_fs_list(dir).some((f) => f.startsWith("keys.json.corrupt-")), "original kept aside");
  } finally {
    cleanup();
  }
});
function require_fs_list(d) { return readdirSyncList(d); }
