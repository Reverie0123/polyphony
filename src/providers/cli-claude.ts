// Claude Code as a contact: `claude -p` with every tool off and all local configuration ignored, so it is only a mouth.
// Verified against Claude Code 2.1.229: --bare, --strict-mcp-config, --setting-sources, --no-session-persistence,
// --tools "", --system-prompt, --output-format stream-json, --verbose, --include-partial-messages.
import type { ChatEvent, ChatFn } from "./types.js";
import { ProviderError } from "./types.js";
import { resolveExecutable, runLines, transcriptPrompt } from "./cli-base.js";
import type { Usage } from "../models.js";

interface ClaudeLine {
  type: string;
  subtype?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: { content?: { type: string; text?: string }[]; usage?: Record<string, number>; model?: string };
  result?: string;
  is_error?: boolean;
  usage?: Record<string, number>;
  total_cost_usd?: number;
  error?: string;
}

export interface ClaudeParseState {
  sawDelta: boolean;
  assistantText: string;
  model?: string;
}

/** Parses one stream-json line. Exported for tests. */
export function parseClaudeLine(line: string, st: ClaudeParseState): ChatEvent[] {
  const out: ChatEvent[] = [];
  let j: ClaudeLine;
  try { j = JSON.parse(line) as ClaudeLine; } catch { return out; }
  if (j.type === "stream_event") {
    const ev = j.event;
    if (ev?.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) { st.sawDelta = true; out.push({ type: "delta", text: ev.delta.text }); }
      else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) out.push({ type: "reasoning", text: ev.delta.thinking });
    }
  } else if (j.type === "assistant") {
    st.model = j.message?.model ?? st.model;
    const text = (j.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (text) st.assistantText += text;
  } else if (j.type === "result") {
    if (j.is_error) throw new ProviderError(j.result || j.error || "claude returned an error", /login|auth/i.test(j.result ?? "") ? "auth" : "unknown");
    if (!st.sawDelta) {
      const text = st.assistantText || j.result || "";
      if (text) out.push({ type: "delta", text });
    }
    const u = j.usage ?? {};
    const usage: Usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      reasoning: 0,
      estimated: false,
    };
    out.push({ type: "usage", usage });
    out.push({ type: "done", finish: j.subtype, model: st.model });
  }
  return out;
}

export const chatClaudeCli: ChatFn = async function* (ctx, req) {
  const exe = resolveExecutable(ctx.account.cliPath, "claude");
  if (!exe) throw new ProviderError("claude command not found; install Claude Code or set the path in the account", "not_found");
  const args = [
    "-p",
    "--bare",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--tools", "",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (req.system) args.push("--system-prompt", req.system);
  if (req.model) args.push("--model", req.model);
  const prompt = transcriptPrompt(req.messages, "You");
  const st: ClaudeParseState = { sawDelta: false, assistantText: "" };
  let done = false;
  // When Polyphony itself was started from inside a Claude Code session, the inherited CLAUDE_CODE_* variables would make
  // the child believe it is a nested session; drop them so the child uses its own login.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_|CLAUDE_PREVIEW_)/.test(k)) env[k] = v;
  env.CLAUDE_CODE_DISABLE_AUTO_UPDATE = "1";
  for await (const line of runLines({ exe, args, cwd: ctx.cliCwd, stdin: prompt, signal: req.signal, idleTimeoutMs: 300000, env })) {
    for (const ev of parseClaudeLine(line, st)) {
      if (ev.type === "done") done = true;
      yield ev;
    }
  }
  if (!done) {
    if (st.assistantText) yield { type: "delta", text: st.assistantText };
    yield { type: "done" };
  }
};
