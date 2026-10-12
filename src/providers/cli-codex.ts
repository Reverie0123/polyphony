// Codex CLI as a contact: `codex exec --json` in a read-only sandbox, outside any git repo, ignoring user config.
// Verified against codex-cli 0.156.1. Codex has no system-prompt flag, so the role card goes into the prompt body.
// Expect whole messages rather than word-by-word streaming; the UI shows a typing indicator meanwhile.
import type { ChatEvent, ChatFn } from "./types.js";
import { ProviderError } from "./types.js";
import { resolveExecutable, runLines, transcriptPrompt } from "./cli-base.js";
import type { Usage } from "../models.js";

interface CodexLine {
  type: string;
  item?: { type?: string; text?: string; content?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
}

export interface CodexParseState {
  text: string;
  emitted: boolean;
}

/** Parses one JSONL line. Exported for tests. */
export function parseCodexLine(line: string, st: CodexParseState): ChatEvent[] {
  const out: ChatEvent[] = [];
  let j: CodexLine;
  try { j = JSON.parse(line) as CodexLine; } catch { return out; }
  if (j.type === "error" || j.type === "turn.failed") {
    const msg = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? "codex returned an error";
    throw new ProviderError(msg, /login|auth|unauthorized/i.test(msg) ? "auth" : "unknown");
  }
  if (j.type === "item.completed" && j.item?.type === "agent_message") {
    const text = j.item.text ?? j.item.content ?? "";
    if (text) { st.text += (st.text ? "\n" : "") + text; st.emitted = true; out.push({ type: "delta", text }); }
  } else if (j.type === "item.completed" && j.item?.type === "reasoning") {
    const text = j.item.text ?? "";
    if (text) out.push({ type: "reasoning", text });
  } else if (j.type === "turn.completed") {
    const u = j.usage ?? {};
    const cacheRead = u.cached_input_tokens ?? 0;
    const usage: Usage = {
      input: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
      output: u.output_tokens ?? 0,
      cacheRead,
      cacheWrite: 0,
      reasoning: u.reasoning_output_tokens ?? 0,
      estimated: false,
    };
    out.push({ type: "usage", usage });
    out.push({ type: "done", finish: "stop" });
  }
  return out;
}

export const chatCodexCli: ChatFn = async function* (ctx, req) {
  const exe = resolveExecutable(ctx.account.cliPath, "codex");
  if (!exe) throw new ProviderError("codex command not found; install Codex CLI or set the path in the account", "not_found");
  const args = ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-C", ctx.cliCwd, "--color", "never"];
  if (req.model) args.push("-m", req.model);
  // "-" makes codex read the prompt from stdin.
  args.push("-");
  const body = transcriptPrompt(req.messages, "You");
  const prompt = req.system ? `${req.system}\n\n---\n\n${body}` : body;
  const st: CodexParseState = { text: "", emitted: false };
  let done = false;
  yield { type: "status", text: "typing" };
  for await (const line of runLines({ exe, args, cwd: ctx.cliCwd, stdin: prompt, signal: req.signal, idleTimeoutMs: 300000 })) {
    for (const ev of parseCodexLine(line, st)) {
      if (ev.type === "done") done = true;
      yield ev;
    }
  }
  if (!done) {
    if (!st.emitted) throw new ProviderError("codex produced no message", "unknown");
    yield { type: "status", text: "usage-missing" };
    yield { type: "done" };
  }
};
