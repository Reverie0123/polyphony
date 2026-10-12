import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startServer, fakeAccountAndContact } from "./helpers.mjs";
import { McpClient } from "../dist/mcp-client.js";
import { parseDriverOverride } from "../dist/deskdock.js";
import { toAnthropicMessages } from "../dist/providers/anthropic.js";

test("McpClient talks to the fake server: initialize, list, call, error, image", async () => {
  const c = new McpClient({ command: process.execPath, args: [path.resolve("tests/fake-mcp.mjs")] });
  await c.start();
  try {
    assert.equal(c.serverInfo.name, "fake-deskdock");
    assert.equal(c.tools.length, 3);
    const r = await c.callTool("list_windows", {});
    assert.ok(r.content[0].text.includes("记事本"));
    const denied = await c.callTool("click", { x: -1, y: 0 });
    assert.equal(denied.isError, true);
    const shot = await c.callTool("screenshot", {});
    assert.ok(shot.content.some((b) => b.type === "image"));
    await assert.rejects(() => c.callTool("nope", {}), /unknown tool/);
  } finally {
    c.close();
  }
});

test("parseDriverOverride and Anthropic tool message mapping", () => {
  assert.equal(parseDriverOverride("@DeskDock(用 Claude) 打开记事本", "DeskDock"), "Claude");
  assert.equal(parseDriverOverride("@DeskDock（小 D）打开记事本", "DeskDock"), "小 D");
  assert.equal(parseDriverOverride("@DeskDock 打开记事本", "DeskDock"), undefined);
  const msgs = toAnthropicMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", args: "{\"k\":1}" }, { id: "b", name: "y", args: "" }] },
    { role: "tool", toolCallId: "a", content: "ra" },
    { role: "tool", toolCallId: "b", content: "rb", images: [{ mime: "image/png", data: "AAAA" }] },
    { role: "assistant", content: "done" },
  ]);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].content[0].type, "tool_use");
  assert.deepEqual(msgs[1].content[0].input, { k: 1 });
  assert.equal(msgs[2].role, "user");
  assert.equal(msgs[2].content.length, 2, "consecutive tool results merge into one user message");
  assert.equal(msgs[2].content[1].content[1].type, "image");
});

test("DeskDock member runs the tool loop: steps recorded, denied call shown, screenshot handled, cost and ledger", async () => {
  const seen = [];
  const srv = await startServer({
    script: (ctx, req) => {
      seen.push(req);
      const calls = req.messages.filter((m) => m.role === "tool").length;
      if (calls === 0) return { pieces: ["先看看窗口。"], toolCalls: [{ id: "c1", name: "list_windows", args: {} }] };
      if (calls === 1) return { pieces: [], toolCalls: [{ id: "c2", name: "click", args: { x: -1, y: 5 } }, { id: "c3", name: "screenshot", args: {} }] };
      return { pieces: ["点击被权限表拒绝了，截图已拿到。"] };
    },
  });
  try {
    const { contact: driver } = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "司机" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: driver.id }, { contactId: "deskdock", driverContactId: driver.id }] })).data;
    assert.equal(s.members[1].driverContactId, driver.id);
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@DeskDock 打开记事本点一下", mentions: ["deskdock"] });
    const done = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === "deskdock", 10000);
    const m = done.data.message;
    assert.equal(m.status, "done");
    assert.equal(m.kind, "steps");
    assert.deepEqual(m.steps.map((x) => [x.tool, x.ok]), [["list_windows", true], ["click", false], ["screenshot", true]]);
    assert.ok(m.steps[1].resultSummary.includes("denied by policy"));
    assert.ok(m.steps[2].resultSummary.includes("[截图]"));
    assert.ok(m.text.includes("先看看窗口") && m.text.includes("拒绝"));
    assert.equal(seen.length, 3);
    assert.ok(seen[0].tools.length === 3 && seen[0].system.includes("DeskDock") && seen[0].system.includes("Fake DeskDock"));
    const toolMsgs = seen[2].messages.filter((x) => x.role === "tool");
    assert.equal(toolMsgs.length, 3);
    assert.ok(toolMsgs[2].content.includes("截图已省略"), "driver without vision gets a note instead of the image");
    assert.ok(m.cost.usd > 0);
    assert.equal(srv.store.readLedger().filter((e) => e.contactId === "deskdock").length, 3);
    assert.ok(m.usage.input > 0);
    const status = (await srv.api("GET", "/api/deskdock/status")).data;
    assert.equal(status.running, true);
    assert.equal(status.toolCount, 3);
  } finally {
    await srv.close();
  }
});

test("DeskDock without a driver fails cleanly; a one-off driver override works; a model mentioning DeskDock asks first", async () => {
  const srv = await startServer({ script: (ctx, req) => (req.tools ? { pieces: ["驱动完成"] } : { pieces: ["让 @DeskDock 看看"] }) });
  try {
    const { contact: driver } = await fakeAccountAndContact(srv.api, srv.store, { model: "deepseek-chat", nickname: "司机" });
    const s = (await srv.api("POST", "/api/sessions", { kind: "group", title: "G", members: [{ contactId: driver.id }, { contactId: "deskdock" }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@DeskDock 做点什么", mentions: ["deskdock"] });
    const noDriver = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === "deskdock");
    assert.equal(noDriver.data.message.status, "error");
    assert.equal(noDriver.data.message.error.code, "no_driver");
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@DeskDock(用 司机) 做点什么" });
    const ok = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === "deskdock" && d.message.status === "done");
    assert.equal(ok.data.message.text, "驱动完成");
    assert.equal(ok.data.message.model, "deepseek-chat");
    // A model mentioning DeskDock always produces a card, even with auto mentions on.
    await srv.api("PATCH", `/api/sessions/${s.id}`, { allowModelMentions: true, members: [{ contactId: driver.id }, { contactId: "deskdock", driverContactId: driver.id }] });
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "@司机 你看", mentions: [driver.id] });
    const card = await srv.waitFor((e, d) => e === "message.created" && d.message.action?.to === "deskdock");
    assert.equal(card.data.message.action.status, "pending");
    await srv.api("POST", `/api/sessions/${s.id}/mentions/${card.data.message.action.id}/approve`);
    const ran = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === "deskdock" && d.message.replyTo === card.data.message.action.sourceMessageId);
    assert.equal(ran.data.message.status, "done");
  } finally {
    await srv.close();
  }
});
