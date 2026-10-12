// Anthropic Messages API over raw HTTP (the project runs without runtime dependencies). Streaming SSE.
import { type ChatEvent, type ChatFn, ProviderError, fetchWithTimeout, httpError, readLines } from "./types.js";
import type { Usage } from "../models.js";

const API_VERSION = "2023-06-01";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function usageFromAnthropic(u: AnthropicUsage | undefined, prev?: Usage): Usage {
  const base = prev ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false };
  return {
    input: u?.input_tokens ?? base.input,
    output: u?.output_tokens ?? base.output,
    cacheRead: u?.cache_read_input_tokens ?? base.cacheRead,
    cacheWrite: u?.cache_creation_input_tokens ?? base.cacheWrite,
    reasoning: base.reasoning,
    estimated: false,
  };
}

interface StreamEvent {
  type: string;
  message?: { usage?: AnthropicUsage; model?: string };
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

interface ParseState {
  usage: Usage;
  blocks: Map<number, { type: string; id: string; name: string; json: string }>;
  model?: string;
}

export function newParseState(): ParseState {
  return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false }, blocks: new Map() };
}

/** Parses one SSE event payload. Exported for tests. */
export function parseAnthropicEvent(json: string, st: ParseState): ChatEvent[] {
  const out: ChatEvent[] = [];
  let ev: StreamEvent;
  try { ev = JSON.parse(json) as StreamEvent; } catch { return out; }
  switch (ev.type) {
    case "message_start":
      st.usage = usageFromAnthropic(ev.message?.usage, st.usage);
      st.model = ev.message?.model;
      break;
    case "content_block_start":
      if (ev.content_block && ev.index !== undefined) {
        st.blocks.set(ev.index, { type: ev.content_block.type, id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", json: "" });
      }
      break;
    case "content_block_delta": {
      const d = ev.delta;
      if (!d) break;
      if (d.type === "text_delta" && d.text) out.push({ type: "delta", text: d.text });
      else if (d.type === "thinking_delta" && d.thinking) out.push({ type: "reasoning", text: d.thinking });
      else if (d.type === "input_json_delta" && ev.index !== undefined) {
        const b = st.blocks.get(ev.index);
        if (b) b.json += d.partial_json ?? "";
      }
      break;
    }
    case "content_block_stop":
      if (ev.index !== undefined) {
        const b = st.blocks.get(ev.index);
        if (b && b.type === "tool_use") out.push({ type: "tool_call", id: b.id, name: b.name, args: b.json || "{}" });
      }
      break;
    case "message_delta":
      st.usage = usageFromAnthropic(ev.usage, st.usage);
      out.push({ type: "usage", usage: st.usage });
      if (ev.delta?.stop_reason) out.push({ type: "done", finish: ev.delta.stop_reason, model: st.model });
      break;
    case "error":
      throw new ProviderError(ev.error?.message ?? "stream error", ev.error?.type === "overloaded_error" ? "server" : "unknown");
    default:
      break;
  }
  return out;
}

export const chatAnthropic: ChatFn = async function* (ctx, req) {
  const base = ctx.account.baseURL.replace(/\/+$/, "") || "https://api.anthropic.com";
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    stream: true,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system) {
    body.system = req.cacheSystem === false ? req.system : [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const res = await fetchWithTimeout(
    `${base}/v1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ctx.key, "anthropic-version": API_VERSION },
      body: JSON.stringify(body),
    },
    req.signal,
    req.firstByteTimeoutMs ?? 60000,
  );
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
  const st = newParseState();
  let finish: string | undefined;
  for await (const line of readLines(res.body, req.signal)) {
    if (!line.startsWith("data:")) continue;
    for (const ev of parseAnthropicEvent(line.slice(5).trim(), st)) {
      if (ev.type === "done") { finish = ev.finish; continue; }
      yield ev;
    }
  }
  if (finish === "refusal") throw new ProviderError("the model declined this request", "refused");
  yield { type: "done", finish, model: st.model };
};
