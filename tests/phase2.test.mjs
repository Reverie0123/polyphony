import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, fakeAccountAndContact } from "./helpers.mjs";
import { parseMentions, exportMarkdown } from "../dist/server.js";
import { Attachments, sniffMime, attachmentText } from "../dist/attachments.js";
import { tempDir } from "./helpers.mjs";

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("parseMentions prefers the longest nickname and ignores non-members", () => {
  const members = [{ contactId: "a", nickname: "小" }, { contactId: "b", nickname: "小 C" }, { contactId: "c", nickname: "乙" }];
  assert.deepEqual(parseMentions("@小 C 和 @乙 说说", members), ["b", "c"]);
  assert.deepEqual(parseMentions("没有点名", members), []);
});

test("attachments: dedup by hash, text files carry their content, images do not", () => {
  const { dir, cleanup } = tempDir();
  try {
    const att = new Attachments(dir);
    const a1 = att.save("notes.md", "", Buffer.from("# 标题\n正文", "utf8"));
    const a2 = att.save("copy.md", "text/markdown", Buffer.from("# 标题\n正文", "utf8"));
    assert.equal(a1.hash, a2.hash);
    assert.equal(a1.caption, "# 标题\n正文");
    assert.equal(a1.mime, "text/markdown");
    const img = att.save("pic.png", "application/octet-stream", PNG_1x1);
    assert.equal(img.mime, "image/png");
    assert.equal(img.caption, undefined);
    assert.ok(att.read(img.hash).bytes.equals(PNG_1x1));
    const again = new Attachments(dir);
    assert.equal(again.get(a1.hash).caption, "# 标题\n正文");
    assert.equal(sniffMime("x.jpg", "", Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.ok(attachmentText(img, "zh").includes("尚未识别"));
    assert.ok(attachmentText(a1, "en").startsWith("[file notes.md]"));
  } finally {
    cleanup();
  }
});

test("upload + message with a text file: the model sees the file content", async () => {
  let seen = "";
  const srv = await startServer({ script: (ctx, req) => { seen = req.messages.map((m) => m.content).join("\n"); return { pieces: ["读到了"] }; } });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    const up = await srv.api("POST", "/api/upload", { name: "data.csv", mime: "text/csv", data: Buffer.from("a,b\n1,2").toString("base64") });
    assert.equal(up.status, 200);
    const sent = await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "看看这个文件", attachments: [up.data.hash] });
    assert.equal(sent.data.message.kind, "file");
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id);
    assert.ok(seen.includes("[文件 data.csv]"));
    assert.ok(seen.includes("a,b\n1,2"));
    const served = await fetch(srv.base + `/api/attachments/${up.data.hash}?token=${srv.token}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "text/csv");
  } finally {
    await srv.close();
  }
});

test("image message: OCR fallback captions the image before the reply, caption is cached", async () => {
  let ocrCalls = 0;
  let seen = "";
  const srv = await startServer({
    script: (ctx, req) => { seen = req.messages.map((m) => m.content).join("\n"); return { pieces: ["看见了"] }; },
    ocr: async () => { ocrCalls++; return { text: "发票 88.50", lang: "zh-CN" }; },
  });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    // The fake contact has no vision flag, so OCR is used.
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    const up = (await srv.api("POST", "/api/upload", { name: "p.png", mime: "image/png", data: PNG_1x1.toString("base64") })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "这张图写了什么", attachments: [up.hash] });
    const done = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id);
    assert.ok(seen.includes("OCR 识别文字"), "caption reached the model");
    assert.ok(seen.includes("发票 88.50"));
    const updated = srv.events.find((e) => e.event === "message.updated" && e.data.message.kind === "image");
    assert.equal(updated.data.message.attachments[0].captionBy, "ocr");
    assert.equal(ocrCalls, 1);
    // Same picture again: served from the cache, OCR not called.
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "再看一次", attachments: [up.hash] });
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.id !== done.data.message.id);
    assert.equal(ocrCalls, 1);
  } finally {
    await srv.close();
  }
});

test("image message with a vision contact: image bytes go to the provider, cost is recorded", async () => {
  let gotImages = 0;
  const srv = await startServer({ script: (ctx, req) => { if (req.images?.length) { gotImages += req.images.length; return { pieces: ["一只猫"] }; } return { pieces: ["ok"] }; } });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    await srv.api("PATCH", `/api/contacts/${contact.id}`, { supportsVision: true });
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    const up = (await srv.api("POST", "/api/upload", { name: "cat.png", mime: "image/png", data: PNG_1x1.toString("base64") })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "", attachments: [up.hash] });
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id);
    assert.equal(gotImages, 1);
    const ledger = srv.store.readLedger();
    assert.ok(ledger.some((e) => e.purpose === "vision"));
    const updated = srv.events.filter((e) => e.event === "message.updated").pop();
    assert.equal(updated.data.message.attachments[0].caption, "一只猫");
    assert.equal(updated.data.message.attachments[0].captionBy, "小 D");
  } finally {
    await srv.close();
  }
});

test("rolling summary: runs after the threshold, feeds later calls, notice and ledger appear", async () => {
  const seenSystems = [];
  const srv = await startServer({
    script: (ctx, req) => {
      seenSystems.push(req.system);
      if (req.system.includes("记录员")) return { pieces: ["摘要：大家讨论了天气"] };
      return { pieces: ["回复"] };
    },
    summary: { minMessages: 3, minTokens: 100000 },
  });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("PATCH", `/api/sessions/${s.id}`, { context: { recentCount: 2, recentTokens: 6000 } });
    for (let i = 0; i < 4; i++) {
      await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "第 " + i + " 句" });
      await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.replyTo && srv.events.filter((x) => x.event === "message.done").length >= i + 1);
    }
    await srv.waitFor((e, d) => e === "message.created" && d.message.kind === "notice", 5000);
    const full = (await srv.api("GET", `/api/sessions/${s.id}`)).data;
    assert.ok(full.summary && full.summary.text.includes("大家讨论了天气"));
    assert.ok(full.summary.coversUpToSeq > 0);
    assert.ok(srv.store.readLedger().some((e) => e.purpose === "summary"));
    // The next reply sees the summary.
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "现在呢" });
    const last = await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.contextInfo?.summaryUsed === true, 5000);
    assert.equal(last.data.message.contextInfo.summaryUsed, true);
  } finally {
    await srv.close();
  }
});

test("edit & resend folds the original; forward copies into another session; export includes both", async () => {
  const srv = await startServer();
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s1 = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    const s2 = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }], title: "目标" })).data;
    const first = (await srv.api("POST", `/api/sessions/${s1.id}/messages`, { text: "原句" })).data.message;
    await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id);
    const edited = (await srv.api("POST", `/api/sessions/${s1.id}/messages`, { text: "改过的句", editedFrom: first.id })).data.message;
    assert.equal(edited.editedFrom, first.id);
    const full = (await srv.api("GET", `/api/sessions/${s1.id}`)).data;
    assert.equal(full.messages.find((m) => m.id === first.id).excludedFromContext, true);
    const fwd = await srv.api("POST", `/api/sessions/${s1.id}/messages/${first.id}/forward`, { targetSessionId: s2.id });
    assert.equal(fwd.status, 200);
    assert.equal(fwd.data.forwardedFrom.messageId, first.id);
    const target = (await srv.api("GET", `/api/sessions/${s2.id}`)).data;
    assert.equal(target.messages.length, 1);
    const md = await fetch(srv.base + `/api/sessions/${s1.id}/export?token=${srv.token}`);
    const text = await md.text();
    assert.ok(text.startsWith("# "));
    assert.ok(text.includes("原句") && text.includes("改过的句") && text.includes("编辑重发"));
    const search = (await srv.api("GET", "/api/search?q=改过")).data;
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].sessionId, s1.id);
  } finally {
    await srv.close();
  }
});

test("exportMarkdown is self-contained", () => {
  const s = { title: "T", intro: "审论文", members: [{ contactId: "a" }], messages: [{ id: "1", seq: 1, sender: "user", kind: "text", text: "hi", attachments: [], createdAt: "2026-10-12T10:00:00.000Z", status: "done" }] };
  const md = exportMarkdown(s, [{ id: "a", nickname: "甲" }], (m) => m.text, { currency: "cny" });
  assert.ok(md.includes("# T") && md.includes("> 审论文") && md.includes("成员：甲") && md.includes("### 我"));
});
