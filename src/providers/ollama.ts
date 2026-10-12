// Local Ollama via /api/chat (NDJSON streaming). Nothing leaves the machine; cost is zero.
import { type ChatEvent, type ChatFn, ProviderError, fetchWithTimeout, httpError, readLines } from "./types.js";

interface OllamaChunk {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export function parseOllamaLine(line: string): ChatEvent[] {
  const out: ChatEvent[] = [];
  let c: OllamaChunk;
  try { c = JSON.parse(line) as OllamaChunk; } catch { return out; }
  if (c.error) throw new ProviderError(c.error, "server");
  if (c.message?.thinking) out.push({ type: "reasoning", text: c.message.thinking });
  if (c.message?.content) out.push({ type: "delta", text: c.message.content });
  let n = 0;
  for (const tc of c.message?.tool_calls ?? []) {
    out.push({ type: "tool_call", id: `ollama_${Date.now()}_${n++}`, name: tc.function?.name ?? "", args: JSON.stringify(tc.function?.arguments ?? {}) });
  }
  if (c.done) {
    out.push({
      type: "usage",
      usage: { input: c.prompt_eval_count ?? 0, output: c.eval_count ?? 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false },
    });
    out.push({ type: "done", finish: c.done_reason, model: c.model });
  }
  return out;
}

export const chatOllama: ChatFn = async function* (ctx, req) {
  const base = (ctx.account.baseURL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  const body: Record<string, unknown> = { model: req.model, messages, stream: true };
  const options: Record<string, unknown> = {};
  if (req.temperature !== undefined) options.temperature = req.temperature;
  if (req.maxTokens) options.num_predict = req.maxTokens;
  if (Object.keys(options).length) body.options = options;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  const res = await fetchWithTimeout(
    `${base}/api/chat`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    req.signal,
    // Local models can take a while to load into memory the first time.
    req.firstByteTimeoutMs ?? 180000,
  );
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
  let finished = false;
  for await (const line of readLines(res.body, req.signal)) {
    for (const ev of parseOllamaLine(line)) {
      if (ev.type === "done") { finished = true; yield ev; break; }
      yield ev;
    }
    if (finished) break;
  }
  if (!finished) yield { type: "done" };
};
