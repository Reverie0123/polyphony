import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, fakeAccountAndContact } from "./helpers.mjs";
import { registerProvider, ProviderError } from "../dist/providers/index.js";
import { fakeProvider } from "./helpers.mjs";

test("token and host checks", async () => {
  const srv = await startServer();
  try {
    const noToken = await fetch(srv.base + "/api/bootstrap");
    assert.equal(noToken.status, 401);
    // fetch refuses to override Host, so use the raw client for the DNS-rebinding check.
    const badHost = await new Promise((resolve, reject) => {
      const req = http.request(srv.base + "/api/bootstrap", { headers: { Host: "evil.example", "x-polyphony-token": srv.token } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 403);
    const ok = await srv.api("GET", "/api/bootstrap");
    assert.equal(ok.status, 200);
    assert.equal(ok.data.version, "test");
    const health = await fetch(srv.base + "/health");
    assert.equal((await health.json()).app, "polyphony");
    const page = await fetch(srv.base + "/");
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("Polyphony"));
    const escape = await fetch(srv.base + "/../package.json");
    assert.equal(escape.status, 404);
  } finally {
    await srv.close();
  }
});

test("direct chat end to end: user message, streamed reply, usage, cost, ledger, persistence", async () => {
  const srv = await startServer();
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    assert.equal(s.title, "小 D");
    const sent = await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "你好" });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.data.message.mentions, [contact.id]);
    const done = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id);
    const reply = done.data.message;
    assert.equal(reply.status, "done");
    assert.equal(reply.text, "Hello world");
    assert.equal(reply.usage.cacheRead, 50);
    assert.equal(reply.cost.priced, true);
    assert.ok(reply.cost.usd > 0);
    assert.equal(reply.contextInfo.historyCount, 1);
    assert.ok(srv.events.some((e) => e.event === "message.delta"));
    assert.equal(srv.store.readLedger().length, 1);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.messages.length, 2);
    assert.ok(full.spentTotal > 0);
    const ledger = (await srv.api("GET", `/api/ledger?sessionId=${s.id}`)).data;
    assert.ok(ledger.sessionUsd > 0 && ledger.todayUsd > 0);
    assert.equal(ledger.byProvider.fake.calls, 1);
  } finally {
    await srv.close();
  }
});

test("provider errors land on the message with a code; missing usage is estimated", async () => {
  // Earlier user turns stay in the window (merged into one user message), so look at the last line only.
  const srv = await startServer({ script: (ctx, req) => (req.messages.at(-1).content.endsWith("boom") ? { error: new ProviderError("key bad", "auth", 401) } : { usage: null }) });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "boom" });
    const failed = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id);
    assert.equal(failed.data.message.status, "error");
    assert.equal(failed.data.message.error.code, "auth");
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "fine" });
    const ok = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.status === "done");
    assert.equal(ok.data.message.usage.estimated, true);
    assert.ok(ok.data.message.usage.output > 0);
  } finally {
    await srv.close();
  }
});

test("cancel stops a streaming reply and keeps the partial text", async () => {
  const srv = await startServer({ script: { pieces: ["a", "b", "c", "d", "e", "f"], delayMs: 120 } });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "go" });
    const created = await srv.waitFor((e, d) => e === "message.created" && d.message.sender === contact.id);
    await new Promise((r) => setTimeout(r, 300));
    const c = await srv.api("POST", `/api/sessions/${s.id}/messages/${created.data.message.id}/cancel`);
    assert.equal(c.data.ok, true);
    const done = await srv.waitFor((e, d) => e === "message.done" && d.message.id === created.data.message.id);
    assert.equal(done.data.message.status, "cancelled");
    assert.ok(done.data.message.text.length >= 1 && done.data.message.text.length < 6);
    assert.equal(done.data.message.usage.estimated, true);
  } finally {
    await srv.close();
  }
});

test("group chat: only mentioned members reply, in mention order, each seeing the previous reply", async () => {
  const seen = [];
  registerProvider("fake", fakeProvider((ctx, req) => { seen.push(req.messages.map((m) => m.content).join("|")); return { pieces: ["ok from ", req.model] }; }));
  const srv = await startServer({ script: (ctx, req) => { seen.push(req.messages.map((m) => m.content).join("|")); return { pieces: ["ok from ", req.model] }; } });
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "model-a", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "model-b", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", intro: "测试群", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] })).data;
    // Nobody mentioned: stored, no reply.
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "大家好" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(srv.events.filter((e) => e.event === "message.created" && e.data.message.sender !== "user").length, 0);
    // Mention b then a.
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@乙 @甲 说说", mentions: [b.contact.id, a.contact.id] });
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === a.contact.id);
    const replies = srv.events.filter((e) => e.event === "message.done").map((e) => e.data.message);
    assert.deepEqual(replies.map((m) => m.sender), [b.contact.id, a.contact.id]);
    assert.equal(replies[0].text, "ok from model-b");
    assert.ok(seen[1].includes("[乙]: ok from model-b"), "second speaker sees the first reply with a name prefix");
    assert.ok(seen[0].includes("[用户]: 大家好"));
  } finally {
    await srv.close();
  }
});

test("preview reports targets, hosts and estimates", async () => {
  const srv = await startServer();
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    const p = (await srv.api("POST", `/api/sessions/${s.id}/preview`, { text: "测试一下" })).data;
    assert.equal(p.targets.length, 1);
    assert.equal(p.targets[0].nickname, "小 D");
    assert.ok(p.targets[0].estimate.tokens > 0);
  } finally {
    await srv.close();
  }
});

test("regenerate folds the old version away and excludes it from context", async () => {
  const srv = await startServer();
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "一" });
    const first = (await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id)).data.message;
    const r = await srv.api("POST", `/api/sessions/${s.id}/messages/${first.id}/regenerate`);
    assert.equal(r.status, 200);
    const second = (await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.id !== first.id)).data.message;
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    const old = full.messages.find((m) => m.id === first.id);
    assert.equal(old.excludedFromContext, true);
    assert.equal(old.versions.length, 1);
    assert.equal(second.contextInfo.historyCount, 1, "old reply is not in the new context");
  } finally {
    await srv.close();
  }
});
