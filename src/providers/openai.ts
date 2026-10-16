// OpenAI-compatible chat completions (DeepSeek by default; also OpenAI, OpenRouter, SiliconFlow, ...). Streaming SSE.
import { type ChatEvent, type ChatFn, ProviderError, fetchWithTimeout, httpError, readLines } from "./types.js";
import type { Usage } from "../models.js";

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export function usageFromOpenAI(u: OpenAIUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  const input = u.prompt_tokens ?? 0;
  // DeepSeek reports cache hits as prompt_cache_hit_tokens; OpenAI under prompt_tokens_details.cached_tokens.
  const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, input - cacheRead),
    output: u.completion_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    estimated: false,
  };
}

interface Chunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage | null;
  error?: { message?: string };
}

/** Parses one SSE data payload into events. Exported for tests. */
export function parseOpenAIChunk(json: string, toolBuf: Map<number, { id: string; name: string; args: string }>): ChatEvent[] {
  const out: ChatEvent[] = [];
  let chunk: Chunk;
  try { chunk = JSON.parse(json) as Chunk; } catch { return out; }
  if (chunk.error?.message) throw new ProviderError(chunk.error.message, "server");
  const choice = chunk.choices?.[0];
  if (choice?.delta) {
    const d = choice.delta;
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (reasoning) out.push({ type: "reasoning", text: reasoning });
    if (d.content) out.push({ type: "delta", text: d.content });
    for (const tc of d.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = toolBuf.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      toolBuf.set(idx, cur);
    }
  }
  if (chunk.usage) {
    const u = usageFromOpenAI(chunk.usage);
    if (u) out.push({ type: "usage", usage: u });
  }
  if (choice?.finish_reason) out.push({ type: "done", finish: choice.finish_reason, model: chunk.model });
  return out;
}

export const chatOpenAI: ChatFn = async function* (ctx, req) {
  const base = ctx.account.baseURL.replace(/\/+$/, "");
  const messages: { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      messages.push({ role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) });
    } else if (m.role === "tool") {
      const content: unknown = m.images?.length
        ? [{ type: "text", text: m.content }, ...m.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } }))]
        : m.content;
      messages.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content });
    } else messages.push({ role: m.role, content: m.content });
  }
  if (req.images?.length) {
    // Images ride on the last user message as a content array.
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (last) {
      last.content = [
        ...req.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } })),
        { type: "text", text: String(last.content) },
      ];
    }
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // OpenAI's own newer models (gpt-5*, o*) take max_completion_tokens and reject temperature values other than 1.
  let official = false;
  try { official = /(^|\.)api\.openai\.com$/i.test(new URL(base).hostname); } catch { /* keep false */ }
  const newGen = official && /^(gpt-5|o\d)/i.test(req.model);
  if (req.temperature !== undefined && !(newGen && req.temperature !== 1)) body.temperature = req.temperature;
  if (req.maxTokens) { if (official) body.max_completion_tokens = req.maxTokens; else body.max_tokens = req.maxTokens; }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const send = (b: Record<string, unknown>) => fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.key}` },
      body: JSON.stringify(b),
    },
    req.signal,
    req.firstByteTimeoutMs ?? 60000,
  );
  let res = await send(body);
  if (res.status === 400) {
    // Some relays reject stream_options; retry once without it before giving up.
    const detail = await res.text().catch(() => "");
    const { stream_options: _dropped, ...withoutUsage } = body;
    res = await send(withoutUsage);
    if (!res.ok) throw httpError(res.status, (await res.text().catch(() => "")) || detail);
  }
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));

  // A relay may answer a stream request with plain JSON: a non-streaming completion, or an error behind HTTP 200.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    const text = await res.text();
    yield* fromJsonBody(text);
    return;
  }
  const toolBuf = new Map<number, { id: string; name: string; args: string }>();
  let finished = false;
  let sawUsage = false;
  let sawData = false;
  let yielded = false;
  const stray: string[] = [];
  for await (const line of readLines(res.body, req.signal)) {
    if (!line.startsWith("data:")) { if (!line.startsWith(":")) stray.push(line); continue; }
    sawData = true;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    for (const ev of parseOpenAIChunk(payload, toolBuf)) {
      if (ev.type === "done") { finished = true; continue; }
      if (ev.type === "usage") sawUsage = true;
      yielded = true;
      yield ev;
    }
  }
  if (!sawData || (!yielded && !toolBuf.size)) {
    // Nothing usable arrived: whatever the relay sent instead is the real story (often an error object without "data:").
    const raw = stray.join("\n").trim();
    if (raw) { yield* fromJsonBody(raw); return; }
    if (!sawData) throw new ProviderError("the server sent no stream", "server");
  }
  for (const [, tc] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
  if (!sawUsage) yield { type: "status", text: "usage-missing" };
  yield { type: "done", finish: finished ? "stop" : undefined };
};

/** Handles a plain JSON body: a completion (yielded as one delta) or an error (thrown with its message). */
function* fromJsonBody(text: string): Generator<ChatEvent> {
  let j: { error?: unknown; message?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: OpenAIUsage; model?: string };
  try { j = JSON.parse(text); } catch { throw new ProviderError(`unexpected reply: ${text.slice(0, 200)}`, "server"); }
  if (j.error !== undefined) {
    const msg = typeof j.error === "string" ? j.error : (j.error as { message?: string })?.message ?? JSON.stringify(j.error);
    throw new ProviderError(msg, /auth|key|unauthori|invalid api/i.test(msg) ? "auth" : /balance|余额|insufficient|quota|欠费/i.test(msg) ? "rate_limit" : "server");
  }
  const content = j.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    if (content) yield { type: "delta", text: content };
    const u = usageFromOpenAI(j.usage);
    if (u) yield { type: "usage", usage: u }; else yield { type: "status", text: "usage-missing" };
    yield { type: "done", finish: j.choices?.[0]?.finish_reason ?? "stop", model: j.model };
    return;
  }
  throw new ProviderError(`unexpected reply: ${(j.message ?? text).slice(0, 200)}`, "server");
}
