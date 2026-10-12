// Shared test helpers: temp data dir, a fake provider, and an in-process server.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../dist/store.js";
import { Pricing } from "../dist/pricing.js";
import { Engine } from "../dist/engine.js";
import { Attachments } from "../dist/attachments.js";
import { Vision } from "../dist/vision.js";
import { Summarizer } from "../dist/summary.js";
import { Orchestrator } from "../dist/orchestrator.js";
import { DeskDock } from "../dist/deskdock.js";
import { createApp } from "../dist/server.js";
import { registerProvider } from "../dist/providers/index.js";

export function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "polyphony-test-"));
  // Child processes (fake MCP server) may still be releasing the directory; retry a few times.
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* leave the temp dir */ } } };
}

/** A provider that streams a canned reply. `script` can be a function of the request for assertions. */
export function fakeProvider(script) {
  return async function* (ctx, req) {
    const plan = typeof script === "function" ? script(ctx, req) : script;
    if (plan.error) throw plan.error;
    for (const piece of plan.pieces ?? ["Hello ", "world"]) {
      if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs));
      if (req.signal?.aborted) { const { ProviderError } = await import("../dist/providers/types.js"); throw new ProviderError("cancelled", "cancelled"); }
      yield { type: "delta", text: piece };
    }
    for (const call of plan.toolCalls ?? []) yield { type: "tool_call", id: call.id, name: call.name, args: JSON.stringify(call.args ?? {}) };
    if (plan.usage !== null) yield { type: "usage", usage: plan.usage ?? { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 0, estimated: false } };
    yield { type: "done", finish: "stop", model: plan.model ?? req.model };
  };
}

export async function startServer({ script, summary, ocr } = {}) {
  const { dir, cleanup } = tempDir();
  registerProvider("fake", fakeProvider(script ?? {}));
  const store = new Store(dir);
  const pricing = new Pricing(dir);
  const events = [];
  const listeners = new Set();
  const broadcast = (e, d) => hub.broadcast(e, d);
  const engine = new Engine({ store, pricing, broadcast, lang: () => "zh" });
  const attachments = new Attachments(dir);
  const summarizer = new Summarizer({ store, pricing, broadcast, lang: () => "zh", call: engine.callContact, ...(summary ?? {}) });
  const vision = new Vision({ store, pricing, attachments, broadcast, lang: () => "zh", call: engine.callContact, ocr });
  const deskdock = new DeskDock({ store, pricing, broadcast, lang: () => "zh", commandOverride: { command: process.execPath, args: [path.resolve("tests/fake-mcp.mjs")] } });
  const orchestrator = new Orchestrator({ store, engine, broadcast, lang: () => "zh", gapMs: () => 20, runDeskdock: (s, m) => deskdock.runTask(s, m) });
  engine.afterReply = (s, m) => { void summarizer.maybeRun(s); void orchestrator.onReply(s, m); };
  const token = "test-token";
  const { server, hub } = createApp({ store, pricing, engine, attachments, vision, summarizer, orchestrator, deskdock, token, version: "test", webDir: path.resolve("web") });
  // Capture broadcasts for assertions without an SSE client.
  const orig = hub.broadcast.bind(hub);
  hub.broadcast = (e, d) => { events.push({ event: e, data: d }); for (const l of listeners) l(e, d); orig(e, d); };
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, extraHeaders = {}) => {
    const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", "x-polyphony-token": token, ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* none */ }
    return { status: res.status, data };
  };
  const waitFor = (pred, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const hit = events.find(({ event, data }) => pred(event, data));
    if (hit) return resolve(hit);
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error("timeout waiting for event")); }, timeoutMs);
    const l = (e, d) => { if (pred(e, d)) { clearTimeout(timer); listeners.delete(l); resolve({ event: e, data: d }); } };
    listeners.add(l);
  });
  const close = async () => { deskdock.restart(); await new Promise((r) => server.close(r)); cleanup(); };
  return { store, pricing, engine, attachments, summarizer, vision, orchestrator, deskdock, api, base, token, events, waitFor, close, dir };
}

/** Registers a fake account whose provider key is "fake" by patching the account after creation. */
export async function fakeAccountAndContact(api, store, { model = "deepseek-chat", nickname = "小 D" } = {}) {
  const acc = (await api("POST", "/api/accounts", { provider: "openai", name: "Fake", baseURL: "http://fake", key: "sk-test" })).data;
  // The registry is keyed by provider; point this account at the fake provider.
  store.updateAccount(acc.id, { provider: "fake" });
  const contact = (await api("POST", "/api/contacts", { accountId: acc.id, model, nickname })).data;
  return { account: store.getAccount(acc.id), contact };
}
