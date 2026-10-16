// Fifth review: stream watchdog, no hand-offs inside a discussion, summary gap, quote visibility, mention boundaries,
// MCP start failure, summary dirty race, semver prerelease.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startServer, fakeAccountAndContact, tempDir } from "./helpers.mjs";
import { registerProvider } from "../dist/providers/index.js";
import { parseMentionsIn } from "../dist/mentions.js";
import { buildContext } from "../dist/context.js";
import { compareSemver } from "../dist/updater.js";
import { McpClient } from "../dist/mcp-client.js";
import { writeFileSync } from "node:fs";

test("a provider that goes silent after the first byte is cut by the idle watchdog; the reply errors with timeout", async () => {
  const srv = await startServer();
  registerProvider("fake", async function* () { yield { type: "delta", text: "一半" }; await new Promise(() => {}); });
  srv.engine.idleMs = 300;
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "hi" });
    const done = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id, 5000);
    assert.equal(done.data.message.status, "error");
    assert.equal(done.data.message.error.code, "timeout");
    assert.equal(done.data.message.text, "一半", "partial text kept");
    assert.equal(srv.engine.busy, 0, "nothing stays in flight");
  } finally {
    await srv.close();
  }
});

test("during a running discussion a model mentioning another member does not trigger an extra reply", async () => {
  const srv = await startServer({ script: (ctx, req) => ({ pieces: ["@乙 你说呢 " + Math.random()], delayMs: 20 }) });
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] })).data;
    await srv.api("PATCH", `/api/sessions/${s.id}`, { allowModelMentions: true });
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 2 });
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("讨论结束"), 10000);
    await new Promise((r) => setTimeout(r, 300));
    const replies = srv.events.filter((e) => e.event === "message.done" && e.data.message.sender !== "user").map((e) => e.data.message);
    assert.equal(replies.length, 4, "exactly one reply per member per round");
    assert.ok(replies.every((m) => m.round !== undefined), "no out-of-band replies without a round");
    assert.ok(!srv.events.some((e) => e.event === "message.created" && e.data.message.kind === "notice" && e.data.message.text.includes("补一句")));
  } finally {
    await srv.close();
  }
});

test("context: unsummarised messages beyond the window are still sent; a whispered quote does not leak", () => {
  const contacts = [{ id: "a", nickname: "甲", persona: "", accountId: "x", model: "m" }, { id: "c", nickname: "丙", persona: "", accountId: "x", model: "m" }];
  const msg = (seq, sender, text, extra = {}) => ({ id: "m" + seq, seq, sender, kind: "text", text, attachments: [], mentions: [], excludedFromContext: false, starred: false, pinned: false, status: "done", createdAt: "", ...extra });
  const messages = [];
  for (let i = 1; i <= 25; i++) messages.push(msg(i, i % 2 ? "user" : "a", "第 " + i + " 句"));
  const s = { id: "s", kind: "group", title: "t", intro: "", members: [{ contactId: "a", roleCard: "", muted: false, order: 0 }, { contactId: "c", roleCard: "", muted: false, order: 1 }], context: { recentCount: 12, recentTokens: 6000 }, summary: null, messages };
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  const all = b.messages.map((m) => m.content).join("\n");
  assert.ok(all.includes("第 1 句"), "nothing before the window is lost while no summary covers it");
  assert.equal(b.info.historyCount, 25);
  // With a summary covering up to 13, the window is the usual 12.
  s.summary = { text: "前面的摘要", coversUpToSeq: 13, generatedAt: "", dirty: false };
  const b2 = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  assert.equal(b2.info.historyCount, 12);
  assert.ok(b2.messages[0].content.includes("前面的摘要"));
  // Whispered message quoted later: 丙 was not a recipient and must not see it through the quote.
  const secret = msg(26, "user", "悄悄话内容", { privateTo: ["a"] });
  const filler = [];
  for (let i = 27; i <= 40; i++) filler.push(msg(i, "user", "填充 " + i));
  const trigger = msg(41, "user", "@丙 看看上面", { replyTo: secret.id });
  s.messages = [...messages, secret, ...filler, trigger];
  s.summary = { text: "x", coversUpToSeq: 27, generatedAt: "", dirty: false };
  const b3 = buildContext(s, contacts[1], s.members[1], contacts, { lang: "zh", trigger });
  assert.ok(!b3.messages.map((m) => m.content).join("\n").includes("悄悄话内容"));
  const b4 = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh", trigger });
  assert.ok(b4.messages.map((m) => m.content).join("\n").includes("悄悄话内容"), "the recipient still sees it");
});

test("mention boundaries: no e-mail hits, no prefix hits, CJK and spaces still work", () => {
  const members = [{ contactId: "a", nickname: "A" }, { contactId: "alice", nickname: "Alice" }, { contactId: "ann", nickname: "Ann" }, { contactId: "xc", nickname: "小 C" }];
  assert.deepEqual(parseMentionsIn("@Alice 看看", members), ["alice"]);
  assert.deepEqual(parseMentionsIn("邮箱 x@Ann.com 不是点名", members), []);
  assert.deepEqual(new Set(parseMentionsIn("@A 和 @小 C，还有 @Ann。", members)), new Set(["a", "xc", "ann"]));
  assert.deepEqual(parseMentionsIn("@Alex 不是成员", members), []);
});

test("McpClient.start kills a child that never answers initialize", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const script = path.join(dir, "silent.mjs");
    writeFileSync(script, "setInterval(() => {}, 1000);\n"); // reads nothing, answers nothing
    const c = new McpClient({ command: process.execPath, args: [script], requestTimeoutMs: 300 });
    await assert.rejects(() => c.start(), /timed out/);
    assert.equal(c.alive, false, "child closed after the failed start");
  } finally {
    cleanup();
  }
});

test("a deletion during a summary run leaves the fresh summary dirty and reruns it", async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = await startServer({
    script: async (ctx, req) => { if (req.system.includes("记录员")) { runs++; if (runs === 1) await gate; return { pieces: ["摘要 " + runs] }; } return { pieces: ["回复"] }; },
    summary: { minMessages: 2, minTokens: 100000 },
  });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("PATCH", `/api/sessions/${s.id}`, { context: { recentCount: 1, recentTokens: 6000 } });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const m = (await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "句 " + i })).data.message;
      ids.push(m.id);
      await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.replyTo === m.id, 5000);
    }
    // The first summary run is now blocked on the gate; delete an early message meanwhile.
    await new Promise((r) => setTimeout(r, 100));
    await srv.api("DELETE", `/api/sessions/${s.id}/messages/${ids[0]}`);
    release();
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("摘要 2") === false && d.message.text.includes("记录员"), 5000).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(runs >= 2, `summary reran after the deletion (runs=${runs})`);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.summary.dirty, false);
    assert.ok(full.summary.text.includes("摘要 " + runs));
  } finally {
    await srv.close();
  }
});

test("compareSemver treats a prerelease as older than its release", () => {
  assert.ok(compareSemver("1.2.0-beta", "1.2.0") < 0);
  assert.ok(compareSemver("1.2.0", "1.2.0-rc.1") > 0);
  assert.ok(compareSemver("1.2.0-alpha", "1.2.0-beta") < 0);
  assert.equal(compareSemver("1.2.0", "1.2.0"), 0);
});
