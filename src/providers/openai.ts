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
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const res = await fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.key}` },
      body: JSON.stringify(body),
    },
    req.signal,
    req.firstByteTimeoutMs ?? 60000,
  );
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
  const toolBuf = new Map<number, { id: string; name: string; args: string }>();
  let finished = false;
  let sawUsage = false;
  for await (const line of readLines(res.body, req.signal)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    for (const ev of parseOpenAIChunk(payload, toolBuf)) {
      if (ev.type === "done") { finished = true; continue; }
      if (ev.type === "usage") sawUsage = true;
      yield ev;
    }
  }
  for (const [, tc] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
  if (!sawUsage) yield { type: "status", text: "usage-missing" };
  yield { type: "done", finish: finished ? "stop" : undefined };
};
