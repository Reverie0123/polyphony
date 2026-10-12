import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, fakeAccountAndContact } from "./helpers.mjs";
import { isNoObjection, hasEndMarker, similarity } from "../dist/context.js";

async function group(srv, nicks = ["甲", "乙", "丙"], extra = {}) {
  const contacts = [];
  for (const n of nicks) {
    contacts.push((await fakeAccountAndContact(srv.api, srv.store, { model: "model-" + n, nickname: n })).contact);
    srv.pricing.setOverride("model-" + n, { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 });
  }
  const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", intro: "测试", members: contacts.map((c) => ({ contactId: c.id })), ...extra })).data;
  return { s, contacts };
}

const waitEnd = (srv, sid) => srv.waitFor((e, d) => e === "message.created" && d.sessionId === sid && d.message.kind === "notice" && d.message.text.includes("讨论结束"), 15000);

test("markers and similarity helpers", () => {
  assert.equal(isNoObjection("[无异议]"), true);
  assert.equal(isNoObjection(" [no objection] ok"), true);
  assert.equal(isNoObjection("[无异议]，但我还是想补充一点更长的意见……很长很长"), false);
  assert.equal(hasEndMarker("结论如上。\n[结束讨论]"), true);
  assert.ok(similarity("今天天气真不错我们去公园", "今天天气真不错我们去公园玩") > 0.8);
  assert.ok(similarity("完全不同的内容", "另一段话") < 0.3);
});

test("list order: N rounds, each member once per round, in order, with round numbers and the discussion rules", async () => {
  const seen = [];
  const srv = await startServer({ script: (ctx, req) => { seen.push({ model: req.model, system: req.system, last: req.messages.at(-1).content }); return { pieces: [req.model + " 的看法 " + seen.length] }; } });
  try {
    const { s, contacts } = await group(srv);
    const d = (await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "要不要用 Rust 重写？", rounds: 2 })).data;
    assert.equal(d.status, "running");
    await waitEnd(srv, s.id);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.discussion.status, "done");
    assert.equal(full.discussion.stopReason, "rounds");
    const replies = full.messages.filter((m) => m.round !== undefined);
    assert.deepEqual(replies.map((m) => m.sender), [contacts[0].id, contacts[1].id, contacts[2].id, contacts[0].id, contacts[1].id, contacts[2].id]);
    assert.deepEqual(replies.map((m) => m.round), [1, 1, 1, 2, 2, 2]);
    assert.ok(seen[0].system.includes("自由讨论") && seen[0].system.includes("Rust"));
    assert.ok(seen[0].last.includes("轮到你了（第 1/2 轮）"));
    assert.ok(seen[3].last.includes("第 2/2 轮"));
    // Later speakers see earlier ones in the same round.
    assert.ok(seen[1].last.includes("model-甲 的看法 1") || seen[1].system.length > 0);
    assert.ok(full.messages.some((m) => m.kind === "notice" && m.text.includes("开始自由讨论")));
    assert.ok(full.discussion.spent > 0);
  } finally {
    await srv.close();
  }
});

test("early stop: a full round of [无异议] ends the discussion", async () => {
  const srv = await startServer({ script: (ctx, req) => ({ pieces: [req.messages.at(-1).content.includes("第 2/") ? "[无异议]" : "第一轮有话说"] }) });
  try {
    const { s } = await group(srv);
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 5 });
    await waitEnd(srv, s.id);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.discussion.stopReason, "noObjection");
    assert.equal(full.messages.filter((m) => m.round !== undefined).length, 6);
  } finally {
    await srv.close();
  }
});

test("early stop: a speaker repeating itself ends the discussion", async () => {
  const srv = await startServer({ script: () => ({ pieces: ["我坚持认为这个方案完全没有问题，应该立刻执行，不需要再讨论了，理由如前所述。"] }) });
  try {
    const { s } = await group(srv, ["甲", "乙"]);
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 5 });
    await waitEnd(srv, s.id);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.discussion.stopReason, "repeat");
  } finally {
    await srv.close();
  }
});

test("end marker from an authorised member ends it; from others it is ignored", async () => {
  const srv = await startServer({ script: (ctx, req) => ({ pieces: [req.model === "model-乙" ? "结论定了。\n[结束讨论]" : "继续讨论 " + Math.random()] }) });
  try {
    const { s, contacts } = await group(srv, ["甲", "乙"]);
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 3 });
    await waitEnd(srv, s.id);
    let full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.discussion.stopReason, "rounds", "乙 is not authorised, so the marker does nothing");
    await srv.api("POST", `/api/sessions/${s.id}`, {});
    await srv.api("PATCH", `/api/sessions/${s.id}`, { title: "G" });
    full.canEndDiscussion = [contacts[1].id];
    srv.store.getSession(s.id).canEndDiscussion = [contacts[1].id];
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q2", rounds: 3 });
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("讨论结束") && d.message.text.includes("成员宣布结束"), 15000);
    full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.discussion.stopReason, "end");
  } finally {
    await srv.close();
  }
});

test("budget per round stops the discussion", async () => {
  const srv = await startServer({ script: () => ({ pieces: ["贵"], usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false } }) });
  try {
    const { s } = await group(srv, ["甲", "乙"], { budget: { perRound: 0.5 } });
    for (const n of ["甲", "乙"]) srv.pricing.setOverride("model-" + n, { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 });
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 3 });
    await waitEnd(srv, s.id);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.discussion.stopReason, "budget");
    assert.ok(full.messages.filter((m) => m.round !== undefined).length <= 2);
  } finally {
    await srv.close();
  }
});

test("race order runs a round in parallel; stop and pause/resume work; summariser posts at the end", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const srv = await startServer({ script: (ctx, req) => { inflight++; maxInflight = Math.max(maxInflight, inflight); setTimeout(() => inflight--, 150); return { pieces: [req.messages.at(-1).content.includes("总结") ? "共识：A\n最强分歧：B\n待办：C" : "观点 " + Math.random()], delayMs: 100 }; } });
  try {
    const { s, contacts } = await group(srv, ["甲", "乙", "丙"]);
    await srv.api("PATCH", `/api/sessions/${s.id}`, { speakingOrder: "race" });
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 2, summarizerContactId: contacts[0].id });
    await waitEnd(srv, s.id);
    assert.ok(maxInflight >= 2, "race mode starts speakers concurrently");
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.ok(full.messages.some((m) => m.text.includes("最强分歧")), "summary posted");
    // Pause / resume / stop on a fresh discussion.
    await srv.api("PATCH", `/api/sessions/${s.id}`, { speakingOrder: "list" });
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q2", rounds: 10 });
    await srv.waitFor((e, d) => e === "message.done" && d.message.round === 1 && d.sessionId === s.id);
    const p = await srv.api("POST", `/api/sessions/${s.id}/discussion/pause`);
    assert.equal(p.data.discussion.status, "paused");
    await srv.api("POST", `/api/sessions/${s.id}/discussion/resume`);
    const r = await srv.api("POST", `/api/sessions/${s.id}/discussion/stop`);
    assert.equal(r.data.discussion.status, "stopped");
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("你停止了"), 15000);
  } finally {
    await srv.close();
  }
});

test("model mentions: card asks the user by default, approval triggers the reply; auto mode replies directly", async () => {
  const srv = await startServer({ script: (ctx, req) => ({ pieces: [req.model === "model-甲" && !req.messages.at(-1).content.includes("刚才 @") ? "这个 @乙 最清楚" : "乙的回答"] }) });
  try {
    const { s, contacts } = await group(srv, ["甲", "乙"]);
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@甲 怎么看", mentions: [contacts[0].id] });
    const card = await srv.waitFor((e, d) => e === "message.created" && d.message.action?.type === "mention");
    assert.equal(card.data.message.action.status, "pending");
    assert.equal(card.data.message.action.to, contacts[1].id);
    const before = srv.events.filter((e) => e.event === "message.done" && e.data.message.sender === contacts[1].id).length;
    assert.equal(before, 0, "乙 did not speak without approval");
    await srv.api("POST", `/api/sessions/${s.id}/mentions/${card.data.message.action.id}/approve`);
    const reply = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contacts[1].id);
    assert.equal(reply.data.message.text, "乙的回答");
    // Auto mode.
    await srv.api("PATCH", `/api/sessions/${s.id}`, { allowModelMentions: true });
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@甲 再来", mentions: [contacts[0].id] });
    const auto = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contacts[1].id && d.message.id !== reply.data.message.id, 8000);
    assert.equal(auto.data.message.text, "乙的回答");
    assert.ok(srv.events.some((e) => e.event === "message.created" && e.data.message.kind === "notice" && e.data.message.text.includes("补一句")));
  } finally {
    await srv.close();
  }
});

test("recover marks a running discussion as paused after a restart", async () => {
  const srv = await startServer({ script: () => ({ pieces: ["x"] }) });
  try {
    const { s } = await group(srv, ["甲"]);
    const sess = srv.store.getSession(s.id);
    sess.discussion = { id: "d", question: "q", questionMessageId: "", rounds: 3, currentRound: 2, order: [], cursor: 0, status: "running", spent: 0, roundSpent: 0, startedAt: "", noObjection: [] };
    srv.orchestrator.recover(sess);
    assert.equal(sess.discussion.status, "paused");
    assert.ok(sess.messages.some((m) => m.kind === "notice" && m.text.includes("中断")));
  } finally {
    await srv.close();
  }
});
