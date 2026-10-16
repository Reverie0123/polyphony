// Regression tests for the second review (2026-10-16): DeskDock summary in history, summariser rules, auto-mention
// chain cap, delete during a discussion, DeskDock regenerate, and the --stop path used by the uninstaller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { startServer, fakeAccountAndContact, tempDir } from "./helpers.mjs";
import { buildContext } from "../dist/context.js";

test("a DeskDock steps message enters later context by its summary text only", () => {
  const contacts = [{ id: "a", nickname: "甲", persona: "", accountId: "x", model: "m" }, { id: "deskdock", nickname: "DeskDock", persona: "", accountId: "", model: "" }];
  const msg = (seq, sender, text, kind = "text", extra = {}) => ({ id: "m" + seq, seq, sender, kind, text, attachments: [], mentions: [], excludedFromContext: false, starred: false, pinned: false, status: "done", createdAt: "", ...extra });
  const s = { id: "s", kind: "group", title: "t", intro: "", members: [{ contactId: "a", roleCard: "", muted: false, order: 0 }, { contactId: "deskdock", roleCard: "", muted: false, order: 1 }], context: { recentCount: 12, recentTokens: 6000 }, summary: null, messages: [
    msg(1, "user", "@DeskDock 打开记事本"),
    msg(2, "deskdock", "已打开记事本并输入了你好。", "steps", { steps: [{ id: "c1", tool: "list_windows", argsSummary: "{}", resultSummary: "很长的窗口列表……", ok: true, startedAt: "" }] }),
    msg(3, "user", "@甲 它做得对吗"),
  ] };
  const b = buildContext(s, contacts[0], s.members[0], contacts, { lang: "zh" });
  const all = b.messages.map((m) => m.content).join("\n");
  assert.ok(all.includes("[DeskDock]: 已打开记事本并输入了你好。"), "summary text is in the history");
  assert.ok(!all.includes("很长的窗口列表"), "step results are not");
});

test("the summariser is not given the discussion rules", async () => {
  const systems = [];
  const srv = await startServer({ script: (ctx, req) => { systems.push(req.system); return { pieces: [req.messages.at(-1).content.includes("总结") ? "共识：x" : "观点 " + Math.random()] }; } });
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 1, summarizerContactId: a.contact.id });
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("讨论结束"), 10000);
    const last = systems[systems.length - 1];
    assert.ok(!last.includes("[无异议]"), "summariser system prompt has no discussion rules");
    assert.ok(systems[0].includes("[无异议]"), "speakers still get them");
  } finally {
    await srv.close();
  }
});

test("automatic model-to-model mentions stop after the chain cap and wait for the user", async () => {
  const srv = await startServer({ script: (ctx, req) => ({ pieces: [req.system.includes("甲（你）") ? "问问 @乙" : "问问 @甲"] }) });
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] })).data;
    await srv.api("PATCH", `/api/sessions/${s.id}`, { allowModelMentions: true });
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@甲 开始", mentions: [a.contact.id] });
    const stop = await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("等你说话"), 10000);
    await new Promise((r) => setTimeout(r, 300));
    const replies = srv.events.filter((e) => e.event === "message.done" && e.data.message.sender !== "user").length;
    const cap = srv.orchestrator.constructor.MAX_AUTO_CHAIN;
    assert.ok(replies <= 1 + cap, `only ${replies} model replies before the chain stopped (cap ${cap})`);
    // The user speaking resets the chain: the next hand-off runs again.
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@乙 再来", mentions: [b.contact.id] });
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice" && d.message.text.includes("补一句") && d.message.seq > stop.data.message.seq, 10000);
  } finally {
    await srv.close();
  }
});

test("deleting a session during a discussion stops it and the file does not come back", async () => {
  const srv = await startServer({ script: () => ({ pieces: ["慢慢说 " + Math.random()], delayMs: 60 }) });
  try {
    const a = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "甲" });
    const b = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "乙" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: a.contact.id }, { contactId: b.contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/discussion`, { question: "q", rounds: 20 });
    await srv.waitFor((e, d) => e === "message.done" && d.message.round === 1, 10000);
    const del = await srv.api("DELETE", `/api/sessions/${s.id}`);
    assert.equal(del.data.ok, true);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(existsSync(path.join(srv.dir, "sessions", s.id + ".json")), false, "session file stays deleted");
    assert.equal((await srv.api("GET", `/api/sessions/${s.id}`)).status, 404);
    assert.equal(srv.orchestrator.busy, 0, "discussion loop ended");
  } finally {
    await srv.close();
  }
});

test("regenerate: a DeskDock reply reruns the task as a new steps message; a model reply regenerates in place", async () => {
  const srv = await startServer({ script: (ctx, req) => (req.tools ? { pieces: ["做好了 " + Math.random()] } : { pieces: ["回复 " + Math.random()] }) });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "司机" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: contact.id }, { contactId: "deskdock", driverContactId: contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@DeskDock 去", mentions: ["deskdock"] });
    const first = (await srv.waitFor((e, d) => e === "message.done" && d.message.sender === "deskdock")).data.message;
    const r = await srv.api("POST", `/api/sessions/${s.id}/messages/${first.id}/regenerate`);
    assert.equal(r.status, 200);
    const second = (await srv.waitFor((e, d) => e === "message.done" && d.message.sender === "deskdock" && d.message.id !== first.id)).data.message;
    assert.equal(second.kind, "steps");
    assert.equal(second.status, "done");
    // A plain model reply regenerates in place: same id, old text folded once, no duplicate message.
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@司机 说", mentions: [contact.id] });
    // Events hold live references and regeneration mutates the message in place, so snapshot it first.
    const reply = structuredClone((await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id)).data.message);
    await srv.api("POST", `/api/sessions/${s.id}/messages/${reply.id}/regenerate`);
    const again = (await srv.waitFor((e, d) => e === "message.done" && d.message.id === reply.id && d.message.text !== reply.text, 10000)).data.message;
    assert.equal(again.versions.length, 1);
    assert.equal(again.versions[0].text, reply.text);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.equal(full.messages.filter((m) => m.sender === contact.id && m.kind === "text").length, 1, "no extra message was created");
  } finally {
    await srv.close();
  }
});

test("--stop ends a running instance through instance.json", async () => {
  const { spawn } = await import("node:child_process");
  const { dir, cleanup } = tempDir();
  const entry = path.resolve("dist/index.js");
  const child = spawn(process.execPath, [entry, "--no-open", "--no-exit", "--no-update-check", "--port", "7389", "--data-dir", dir], { stdio: "ignore", windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); try { up = (await fetch("http://127.0.0.1:7389/health")).ok; } catch { /* not yet */ } }
    assert.ok(up, "instance started");
    const { stopRunning } = await import("../dist/index.js");
    assert.equal(await stopRunning(dir), true);
    let down = false;
    for (let i = 0; i < 20 && !down; i++) { await new Promise((r) => setTimeout(r, 200)); try { await fetch("http://127.0.0.1:7389/health"); } catch { down = true; } }
    assert.ok(down, "instance gone");
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    cleanup();
  }
});
