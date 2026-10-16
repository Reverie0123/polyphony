// Regression tests for the review of 2026-10-16: first-byte timeout, relay quirks, error classification, pricing names.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWithTimeout, readLines, ProviderError } from "../dist/providers/types.js";
import { chatOpenAI } from "../dist/providers/openai.js";
import { normalizeModel, Pricing } from "../dist/pricing.js";
import { classifyError } from "../dist/engine.js";
import { startServer, fakeAccountAndContact, tempDir } from "./helpers.mjs";

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}

test("first-byte timeout does not cut a slow body once the headers have arrived", async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n");
    setTimeout(() => { res.write("data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n"); res.end("data: [DONE]\n\n"); }, 900);
  });
  try {
    const res = await fetchWithTimeout(base, { method: "POST" }, undefined, 300);
    const lines = [];
    for await (const l of readLines(res.body)) lines.push(l);
    assert.equal(lines.filter((l) => l.startsWith("data:")).length, 3, "both chunks arrived although the body took longer than the first-byte timeout");
  } finally {
    await close();
  }
});

test("first-byte timeout still fires when the headers never come; a body cut by the server is a network error", async () => {
  const { base, close } = await serve((req, res) => {
    if (req.url === "/slow") setTimeout(() => { res.writeHead(200); res.end("late"); }, 800);
    else { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: x\n\n"); setTimeout(() => res.destroy(), 100); }
  });
  try {
    await assert.rejects(() => fetchWithTimeout(base + "/slow", {}, undefined, 200), (e) => e instanceof ProviderError && e.code === "timeout");
    const res = await fetchWithTimeout(base + "/cut", {}, undefined, 1000);
    await assert.rejects(async () => { for await (const _ of readLines(res.body)) { /* drain */ } }, (e) => e instanceof ProviderError && e.code === "network");
  } finally {
    await close();
  }
});

test("classifyError: DOMException aborts are not unknown", () => {
  assert.equal(classifyError(new DOMException("x", "TimeoutError")).code, "timeout");
  assert.equal(classifyError(new DOMException("x", "AbortError")).code, "network");
  const ac = new AbortController(); ac.abort();
  assert.equal(classifyError(new DOMException("x", "AbortError"), ac.signal).code, "cancelled");
  assert.equal(classifyError(new Error("boom")).code, "unknown");
});

test("OpenAI-compatible: HTTP 200 with a JSON error body is an error, not an empty success", async () => {
  const { base, close } = await serve((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "余额不足" })); });
  try {
    const ctx = { account: { provider: "openai", baseURL: base }, key: "k", cliCwd: "." };
    await assert.rejects(async () => { for await (const _ of chatOpenAI(ctx, { model: "m", system: "", messages: [{ role: "user", content: "hi" }] })) { /* drain */ } }, (e) => e instanceof ProviderError && /余额/.test(e.message));
  } finally {
    await close();
  }
});

test("OpenAI-compatible: an SSE-typed reply that carries a bare error object (no data: prefix) is still an error", async () => {
  const { base, close } = await serve((req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end("{\"error\":{\"message\":\"invalid api key\"}}\n"); });
  try {
    const ctx = { account: { provider: "openai", baseURL: base }, key: "k", cliCwd: "." };
    await assert.rejects(async () => { for await (const _ of chatOpenAI(ctx, { model: "m", system: "", messages: [{ role: "user", content: "hi" }] })) { /* drain */ } }, (e) => e instanceof ProviderError && e.code === "auth");
  } finally {
    await close();
  }
});

test("OpenAI-compatible: a relay that rejects stream_options with 400 gets one retry without it; plain JSON completions work", async () => {
  const bodies = [];
  const { base, close } = await serve((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const b = JSON.parse(data);
      bodies.push(b);
      if (b.stream_options) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "unknown field stream_options" } })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "relay-model", choices: [{ message: { content: "整段回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4 } }));
    });
  });
  try {
    const ctx = { account: { provider: "openai", baseURL: base }, key: "k", cliCwd: "." };
    const events = [];
    for await (const ev of chatOpenAI(ctx, { model: "m", system: "", messages: [{ role: "user", content: "hi" }] })) events.push(ev);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].stream_options, undefined);
    assert.deepEqual(events[0], { type: "delta", text: "整段回复" });
    assert.equal(events.find((e) => e.type === "usage").usage.input, 9);
    assert.equal(events.find((e) => e.type === "done").model, "relay-model");
  } finally {
    await close();
  }
});

test("engine: a provider failure after partial text is an error with no ledger entry; an empty reply is an error", async () => {
  let mode = "cut";
  const srv = await startServer({ script: () => (mode === "cut" ? { pieces: ["half"], error: Object.assign(new DOMException("aborted", "AbortError"), {}) } : { pieces: [] }) });
  try {
    const { contact } = await fakeAccountAndContact(srv.api, srv.store);
    const s = (await srv.api("POST", "/api/sessions", { kind: "direct", members: [{ contactId: contact.id }] })).data;
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "一" });
    const cut = (await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id)).data.message;
    assert.equal(cut.status, "error");
    assert.equal(cut.error.code, "network");
    assert.equal(cut.cost.priced, false);
    assert.equal(srv.store.readLedger().length, 0, "nothing charged for a failed call without reported usage");
    mode = "empty";
    await srv.api("POST", `/api/sessions/${s.id}/messages`, { text: "二" });
    const empty = (await srv.waitFor((e, d) => e === "message.done" && d.message.sender === contact.id && d.message.id !== cut.id)).data.message;
    assert.equal(empty.status, "error");
    assert.equal(empty.error.code, "empty_reply");
  } finally {
    await srv.close();
  }
});

test("pricing: dated and suffixed model names resolve; unknown models stay unpriced and are counted", () => {
  assert.equal(normalizeModel("gpt-4o-2024-08-06"), "gpt-4o");
  assert.equal(normalizeModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModel("gemini-2.5-pro-preview"), "gemini-2.5-pro");
  const { dir, cleanup } = tempDir();
  try {
    const p = new Pricing(dir);
    assert.ok(p.lookup("openai", "gpt-4o-2024-08-06"));
    assert.ok(p.lookup("anthropic", "claude-sonnet-4-5-20250929"));
    assert.ok(p.lookup("openai", "gpt-4o-mini-2024-07-18"));
    assert.equal(p.lookup("openai", "deepseek-chat-v3").input, 0.28, "prefix fallback");
    assert.equal(p.lookup("openai", "totally-unknown"), undefined);
  } finally {
    cleanup();
  }
});
