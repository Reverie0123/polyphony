import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, cleanReply } from "../dist/context.js";

const contacts = [
  { id: "a", nickname: "甲", persona: "你是甲。", accountId: "x", model: "m" },
  { id: "b", nickname: "乙", persona: "", accountId: "x", model: "m" },
];

let seq = 1;
const msg = (sender, text, extra = {}) => ({
  id: "m" + seq, seq: seq++, sender, kind: "text", text, attachments: [], mentions: [], excludedFromContext: false,
  starred: false, pinned: false, status: "done", createdAt: new Date().toISOString(), ...extra,
});

function session(kind, messages, extra = {}) {
  return {
    id: "s", kind, title: "t", intro: kind === "group" ? "审论文" : "", members: [{ contactId: "a", roleCard: "", muted: false, order: 0 }, { contactId: "b", roleCard: "你是挑刺的人", muted: false, order: 1 }],
    context: { recentCount: 12, recentTokens: 6000 }, summary: null, messages, nextSeq: seq, ...extra,
  };
}

test("direct chat: plain roles, no prefixes, no group rules", () => {
  seq = 1;
  const s = session("direct", [msg("user", "你好"), msg("a", "你好呀"), msg("user", "再见")]);
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  assert.ok(b.system.includes("你是甲"));
  assert.ok(b.system.includes("一对一"));
  assert.ok(!b.system.includes("群成员"));
  assert.deepEqual(b.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(b.messages[0].content, "你好");
  assert.equal(b.info.historyCount, 3);
});

test("group chat: role card wins, others get name prefixes, consecutive user turns merge", () => {
  seq = 1;
  const s = session("group", [msg("user", "开始"), msg("a", "我是甲"), msg("b", "我是乙"), msg("user", "@乙 继续")]);
  const b = buildContext(s, contacts[1], s.members[1], contacts, { lang: "zh" });
  assert.ok(b.system.startsWith("你是挑刺的人"));
  assert.ok(b.system.includes("审论文"));
  assert.ok(b.system.includes("- 乙（你）"));
  assert.deepEqual(b.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(b.messages[0].content, "[用户]: 开始\n\n[甲]: 我是甲");
  assert.equal(b.messages[1].content, "我是乙");
  assert.equal(b.messages[2].content, "[用户]: @乙 继续");
});

test("window honours recentCount and drops a leading assistant turn", () => {
  seq = 1;
  const many = [];
  for (let i = 0; i < 10; i++) { many.push(msg("user", "q" + i)); many.push(msg("a", "r" + i)); }
  // Unsummarised messages are never dropped, so the window limit applies once a summary covers the earlier ones.
  const s = session("direct", many, { context: { recentCount: 4, recentTokens: 6000 }, summary: { text: "之前的对话", coversUpToSeq: 16, generatedAt: "", dirty: false } });
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  assert.equal(b.info.historyCount, 4);
  assert.equal(b.info.summaryUsed, true);
  assert.equal(b.messages[0].role, "user");
  // The window ends on an assistant turn, so a continue nudge is appended.
  assert.equal(b.messages[b.messages.length - 1].role, "user");
});

test("summary is prepended as a user turn and lets the window start with assistant text", () => {
  seq = 1;
  const s = session("direct", [msg("user", "old"), msg("a", "A1"), msg("user", "new"), msg("a", "A2")], {
    context: { recentCount: 3, recentTokens: 6000 },
    summary: { text: "之前聊了 old", coversUpToSeq: 1, generatedAt: "", dirty: false },
  });
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  assert.equal(b.info.summaryUsed, true);
  assert.ok(b.messages[0].content.includes("之前聊了 old"));
  assert.equal(b.messages[1].role, "assistant");
});

test("quoted message outside the window is attached in full; excluded, whisper and failed messages are skipped", () => {
  seq = 1;
  const quoted = msg("a", "这是很久以前的话");
  const list = [quoted];
  for (let i = 0; i < 6; i++) list.push(msg("user", "filler " + i));
  list.push(msg("user", "secret", { privateTo: ["b"] }));
  list.push(msg("user", "gone", { excludedFromContext: true }));
  list.push(msg("a", "broken", { status: "error" }));
  const trigger = msg("user", "回这条", { replyTo: quoted.id });
  list.push(trigger);
  const s = session("group", list, { context: { recentCount: 3, recentTokens: 6000 }, summary: { text: "早先的摘要", coversUpToSeq: quoted.seq + 2, generatedAt: "", dirty: false } });
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh", trigger });
  const all = b.messages.map((m) => m.content).join("\n");
  assert.ok(all.includes("用户引用了这条消息"));
  assert.ok(all.includes("这是很久以前的话"));
  assert.ok(!all.includes("secret"));
  assert.ok(!all.includes("gone"));
  assert.ok(!all.includes("broken"));
});

test("long history messages are cut, quoted ones are not", () => {
  seq = 1;
  const long = "字".repeat(2000);
  const s = session("direct", [msg("user", long), msg("a", "ok"), msg("user", "再来")]);
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh", maxMessageChars: 100 });
  assert.ok(b.messages[0].content.endsWith("…[已截断]"));
  assert.ok(b.messages[0].content.length < 200);
});

test("cleanReply strips the self prefix and cuts impersonation", () => {
  assert.deepEqual(cleanReply("[甲]: 我觉得可以", "甲", ["乙"]), { text: "我觉得可以", truncatedImpersonation: false });
  const r = cleanReply("我的看法是 A。\n[乙]: 我反对。", "甲", ["乙"]);
  assert.equal(r.text, "我的看法是 A。");
  assert.equal(r.truncatedImpersonation, true);
  assert.equal(cleanReply("正常回复", "甲", ["乙"]).truncatedImpersonation, false);
});

test("a DeskDock steps message enters history through its text summary; notices never do", () => {
  seq = 1;
  const s = session("group", [
    msg("user", "@DeskDock 打开记事本"),
    msg("deskdock", "已经打开记事本并输入了内容。", { kind: "steps", steps: [{ id: "c1", tool: "click", argsSummary: "{}", resultSummary: "ok", ok: true, startedAt: "x" }] }),
    msg("system", "讨论结束", { kind: "notice" }),
    msg("user", "然后呢"),
  ]);
  const built = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  const joined = built.messages.map((m) => m.content).join("\n");
  assert.ok(joined.includes("已经打开记事本"), "the summary text is visible to other members");
  assert.ok(!joined.includes("讨论结束"), "notices stay out");
});
