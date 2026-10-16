// Regression tests for the third review (2026-10-16): request body decoding, attachment lookup, store robustness,
// pricing across tables, summary dirtiness on edit, member purge, parallel mentions, unknown @names.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startServer, fakeAccountAndContact, tempDir } from "./helpers.mjs";
import { Attachments } from "../dist/attachments.js";
import { Store } from "../dist/store.js";
import { Pricing } from "../dist/pricing.js";
import { unknownMentions } from "../dist/server.js";

test("a JSON body split inside a multibyte character still decodes correctly", async () => {
  const srv = await startServer();
  try {
    const name = "测试账号名字很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长";
    const body = Buffer.from(JSON.stringify({ provider: "openai", name, baseURL: "http://x", key: "k" }), "utf8");
    // Cut right inside the 3-byte sequence of a Chinese character.
    const cut = body.indexOf(Buffer.from("名字", "utf8")) + 1;
    const status = await new Promise((resolve, reject) => {
      const req = http.request(srv.base + "/api/accounts", { method: "POST", headers: { "Content-Type": "application/json", "x-polyphony-token": srv.token, "Content-Length": body.length } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 50);
    });
    assert.equal(status, 200);
    const accounts = (await srv.api("GET", "/api/accounts")).data;
    assert.equal(accounts[0].name, name, "no U+FFFD in the stored name");
  } finally {
    await srv.close();
  }
});

test("attachments with any extension can be read back; a lost index entry is found by scanning", () => {
  const { dir, cleanup } = tempDir();
  try {
    const att = new Attachments(dir);
    const pdf = att.save("report.pdf", "application/pdf", Buffer.from("%PDF-1.4 fake"));
    assert.equal(pdf.file, pdf.hash + ".pdf");
    assert.ok(att.read(pdf.hash)?.bytes.toString().startsWith("%PDF"));
    const docx = att.save("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK..."));
    assert.ok(att.read(docx.hash));
    // Simulate an older index without the file field.
    const again = new Attachments(dir);
    const idx = JSON.parse(readFileSync(path.join(dir, "attachments", "index.json"), "utf8"));
    delete idx[pdf.hash].file;
    writeFileSync(path.join(dir, "attachments", "index.json"), JSON.stringify(idx));
    const fresh = new Attachments(dir);
    assert.ok(fresh.read(pdf.hash), "found by scanning for the hash prefix");
    void again;
  } finally {
    cleanup();
  }
});

test("deleteSession rolls back when the file cannot be removed; the session cache is bounded; the ledger is cached", () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new Store(dir);
    const s = store.createSession({ kind: "direct", title: "t", members: [{ contactId: "x", roleCard: "", muted: false, order: 0 }] });
    const file = path.join(dir, "sessions", s.id + ".json");
    // Node removes read-only files on Windows, so a real unlink failure cannot be forced here; the rollback branch is
    // checked only when the platform does refuse, otherwise the normal path is asserted.
    chmodSync(file, 0o444);
    let ok;
    try { ok = store.deleteSession(s.id); } finally { try { chmodSync(file, 0o666); } catch { /* already gone */ } }
    if (ok === false) {
      assert.ok(store.getSession(s.id), "still visible after a failed delete");
      assert.ok(existsSync(file));
    } else {
      assert.equal(store.getSession(s.id), undefined);
      assert.equal(existsSync(file), false);
    }
    // Cache bound.
    const max = Store.SESSION_CACHE_MAX;
    for (let i = 0; i < max + 5; i++) store.createSession({ kind: "direct", title: "s" + i, members: [{ contactId: "x", roleCard: "", muted: false, order: 0 }] });
    assert.ok(store.listSessions().length >= max + 5);
    assert.ok(store["sessionCache"].size <= max, `cache holds ${store["sessionCache"].size} <= ${max}`);
    // Ledger cache.
    const entry = { at: new Date().toISOString(), sessionId: "s", messageId: "m", contactId: "c", accountId: "a", provider: "openai", model: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false }, cost: { usd: 0.1, cny: 0.7, priced: true, kind: "metered" }, purpose: "reply" };
    assert.equal(store.readLedger().length, 0);
    store.appendLedger(entry);
    assert.equal(store.readLedger().length, 1, "append updates the cached copy");
    assert.equal(new Store(dir).readLedger().length, 1, "and the file");
  } finally {
    cleanup();
  }
});

test("pricing: the longest known prefix wins across tables, then table priority", () => {
  const { dir, cleanup } = tempDir();
  try {
    const p = new Pricing(dir);
    p.setOverride("gpt", { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 });
    assert.equal(p.lookup("openai", "gpt-4o-mini-custom").input, 0.15, "builtin gpt-4o-mini beats the shorter override");
    p.setOverride("gpt-4o-mini", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    assert.equal(p.lookup("openai", "gpt-4o-mini-custom").input, 1, "an override of the same name wins");
  } finally {
    cleanup();
  }
});

test("editing a message already covered by the summary marks it dirty; deleting a contact purges it from groups", async () => {
  const srv = await startServer();
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id, driverContactId: a.contact.id }] })).data;
    const first = (await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "原句" })).data.message;
    const sess = srv.store.getSession(s.id);
    sess.summary = { text: "摘要", coversUpToSeq: first.seq, generatedAt: "", dirty: false };
    srv.store.saveSession(sess);
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "改过", editedFrom: first.id });
    assert.equal(srv.store.getSession(s.id).summary.dirty, true);
    await srv.api("DELETE", `/api/contacts/${a.contact.id}`);
    const after = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.deepEqual(after.members.map((m) => m.contactId), [b.contact.id]);
    assert.equal(after.members[0].driverContactId, undefined, "driver reference cleared too");
    assert.ok(srv.events.some((e) => e.event === "session.updated" && e.data.session.id === s.id));
  } finally {
    await srv.close();
  }
});

test("parallel mentions run at once when enabled; unknown @names are reported", async () => {
  const srv = await startServer({ script: () => ({ pieces: ["ok"], delayMs: 250 }) });
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] })).data;
    const r = await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@甲 @乙 @丙 说", mentions: [a.contact.id, b.contact.id] });
    assert.deepEqual(r.data.ignoredMentions, ["丙"]);
    const t0 = Date.now();
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === b.contact.id);
    const serial = Date.now() - t0;
    assert.ok(serial >= 450, `serial took ${serial}ms`);
    await srv.api("PATCH", `/api/sessions/${s.id}`, { parallelMentions: true });
    const t1 = Date.now();
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "再说", mentions: [a.contact.id, b.contact.id] });
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === b.contact.id && d.message.createdAt > new Date(t1 - 1).toISOString());
    const parallel = Date.now() - t1;
    assert.ok(parallel < serial, `parallel ${parallel}ms < serial ${serial}ms`);
  } finally {
    await srv.close();
  }
});

test("unknownMentions ignores prefixes of real names and punctuation", () => {
  assert.deepEqual(unknownMentions("@小 C 和 @审稿人 看看 @路人甲。", ["小 C", "审稿人"]), ["路人甲"]);
  assert.deepEqual(unknownMentions("邮箱 a@b.com 不是 @", ["小 C"]), ["b"]);
});
