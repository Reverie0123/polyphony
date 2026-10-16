// Seventh review: truncated .tmp never replaces a good file, ledger recovery, distinct member nicknames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { Store, recoverTmp } from "../dist/store.js";
import { startServer, fakeAccountAndContact, tempDir } from "./helpers.mjs";

test("a truncated .tmp is discarded and the original file kept; a complete one is promoted", () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ currency: "cny" }));
    writeFileSync(file + ".tmp", '{"currency": "us'); // cut mid-write
    const later = new Date(Date.now() + 5000);
    utimesSync(file + ".tmp", later, later);
    recoverTmp(file);
    assert.equal(existsSync(file + ".tmp"), false, "broken tmp removed");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).currency, "cny", "good file untouched");
    writeFileSync(file + ".tmp", JSON.stringify({ currency: "usd" }));
    utimesSync(file + ".tmp", later, later);
    recoverTmp(file);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).currency, "usd");
    // Ledger: a tmp whose last line is cut is ignored; a complete one is used.
    const ledger = path.join(dir, "ledger.jsonl");
    writeFileSync(ledger, '{"a":1}\n');
    writeFileSync(ledger + ".tmp", '{"a":1}\n{"a":2');
    utimesSync(ledger + ".tmp", later, later);
    recoverTmp(ledger);
    assert.equal(readFileSync(ledger, "utf8"), '{"a":1}\n');
    writeFileSync(ledger + ".tmp", '{"a":1}\n{"a":2}\n');
    utimesSync(ledger + ".tmp", later, later);
    recoverTmp(ledger);
    assert.equal(readFileSync(ledger, "utf8"), '{"a":1}\n{"a":2}\n');
    const store = new Store(dir);
    assert.equal(store.readLedger().length, 2, "readLedger goes through recovery");
  } finally {
    cleanup();
  }
});

test("a group cannot hold two members with the same nickname", async () => {
  const srv = await startServer();
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "写手" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "other-model", nickname: "写手" });
    const r = await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "duplicate_nickname");
    const ok = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }] })).data;
    const p = await srv.api("PATCH", `/api/sessions/${ok.id}`, { members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] });
    assert.equal(p.status, 400);
    // Renaming a member to another member's nickname is refused; an unrelated contact can still take the name.
    const c = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "审稿人" });
    const g = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G2", members: [{ contactId: a.contact.id }, { contactId: c.contact.id }] })).data;
    assert.ok(g.id);
    const rn = await srv.api("PATCH", `/api/contacts/${c.contact.id}`, { nickname: "写手" });
    assert.equal(rn.status, 400);
    assert.equal(rn.data.code, "duplicate_nickname");
    assert.equal((await srv.api("PATCH", `/api/contacts/${b.contact.id}`, { nickname: "审稿人" })).status, 200, "b is in no group with c");
    assert.equal((await srv.api("PATCH", `/api/contacts/${c.contact.id}`, { nickname: "校对" })).status, 200);
  } finally {
    await srv.close();
  }
});
