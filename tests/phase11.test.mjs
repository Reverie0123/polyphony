// Sixth review: tmp recovery at startup and flush at exit, atomic ledger rewrite, extra-message accounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { Store, recoverTmp, flushPendingWrites, writeTextAtomic } from "../dist/store.js";
import { buildContext } from "../dist/context.js";
import { tempDir } from "./helpers.mjs";

test("a newer .tmp left behind is recovered on the next read; an older one is discarded", () => {
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ currency: "cny" }));
    writeFileSync(file + ".tmp", JSON.stringify({ currency: "usd" }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file + ".tmp", later, later);
    const store = new Store(dir);
    assert.equal(store.getSettings().currency, "usd", "the newer tmp won");
    assert.equal(existsSync(file + ".tmp"), false);
    // Older tmp: dropped.
    writeFileSync(file + ".tmp", JSON.stringify({ currency: "cny" }));
    const earlier = new Date(Date.now() - 60000);
    utimesSync(file + ".tmp", earlier, earlier);
    recoverTmp(file);
    assert.equal(existsSync(file + ".tmp"), false);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).currency, "usd");
    // A session that only exists as .tmp is listed and readable.
    const s = store.createSession({ kind: "direct", title: "t", members: [{ contactId: "x", roleCard: "", muted: false, order: 0 }] });
    const sf = path.join(dir, "sessions", s.id + ".json");
    writeFileSync(sf + ".tmp", readFileSync(sf, "utf8").replace('"title": "t"', '"title": "recovered"'));
    utimesSync(sf + ".tmp", later, later);
    const fresh = new Store(dir);
    assert.equal(fresh.getSession(s.id).title, "recovered");
    assert.ok(fresh.listSessions().some((x) => x.id === s.id));
  } finally {
    cleanup();
  }
});

test("flushPendingWrites and writeTextAtomic", () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.equal(flushPendingWrites(), 0, "nothing pending");
    const file = path.join(dir, "ledger.jsonl");
    writeTextAtomic(file, "a\nb\n");
    assert.equal(readFileSync(file, "utf8"), "a\nb\n");
    assert.equal(existsSync(file + ".tmp"), false);
  } finally {
    cleanup();
  }
});

test("contextInfo reports how many messages were sent beyond the window because the summary lagged", () => {
  const contacts = [{ id: "a", nickname: "甲", persona: "", accountId: "x", model: "m" }];
  const msg = (seq, sender, text) => ({ id: "m" + seq, seq, sender, kind: "text", text, attachments: [], mentions: [], excludedFromContext: false, starred: false, pinned: false, status: "done", createdAt: "" });
  const messages = [];
  for (let i = 1; i <= 20; i++) messages.push(msg(i, i % 2 ? "user" : "a", "句 " + i));
  const s = { id: "s", kind: "direct", title: "t", intro: "", members: [{ contactId: "a", roleCard: "", muted: false, order: 0 }], context: { recentCount: 5, recentTokens: 6000 }, summary: null, messages };
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  assert.equal(b.info.historyCount, 20);
  assert.equal(b.info.extraUnsummarised, 15);
  s.summary = { text: "x", coversUpToSeq: 15, generatedAt: "", dirty: false };
  const b2 = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  assert.equal(b2.info.historyCount, 5);
  assert.equal(b2.info.extraUnsummarised, undefined);
});
