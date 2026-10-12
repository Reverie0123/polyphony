// Shared subprocess plumbing for local CLI contacts (claude, codex). Spawns the executable directly, never a shell,
// feeds the prompt over stdin, and yields stdout line by line. Killing the process is the cancel path.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ProviderError } from "./types.js";
import type { ChatMessage } from "./types.js";

export interface SpawnOptions {
  exe: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  /** Milliseconds without any stdout line before the process is considered stuck. */
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Finds an executable on PATH (Windows: also .cmd / .exe), or returns the explicit path if it exists. */
export function resolveExecutable(explicit: string | undefined, name: string): string | undefined {
  if (explicit?.trim()) return existsSync(explicit.trim()) ? explicit.trim() : undefined;
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function spawnDirect(exe: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  // .cmd shims need cmd.exe behind them; pass the path quoted and the arguments as a single array so no user text is parsed by the shell.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${exe}" ${args.map(quoteWin).join(" ")}`], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(exe, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

function quoteWin(a: string): string {
  if (a === "") return '""';
  if (!/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}

/** Runs the process and yields stdout lines. stderr is collected for the error message. */
export async function* runLines(opts: SpawnOptions): AsyncGenerator<string> {
  const child = spawnDirect(opts.exe, opts.args, opts.cwd, opts.env);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const queue: string[] = [];
  let waiting: (() => void) | null = null;
  let ended = false;
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  let buf = "";
  const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.trim()) queue.push(line);
    }
    wake();
  });
  child.on("error", (e) => { spawnError = e; ended = true; wake(); });
  child.on("close", (code) => { if (buf.trim()) queue.push(buf); buf = ""; exitCode = code; ended = true; wake(); });
  const kill = () => { try { child.kill(); } catch { /* ignore */ } if (process.platform === "win32" && child.pid) { try { spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* ignore */ } } };
  const onAbort = () => { kill(); wake(); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.stdin !== undefined) {
    child.stdin?.on("error", () => { /* process may exit before reading stdin */ });
    child.stdin?.end(opts.stdin, "utf8");
  } else child.stdin?.end();
  const idle = opts.idleTimeoutMs ?? 600000;
  try {
    while (true) {
      if (opts.signal?.aborted) throw new ProviderError("cancelled", "cancelled");
      if (queue.length) { yield queue.shift()!; continue; }
      if (ended) break;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await new Promise<boolean>((resolve) => {
        waiting = () => { clearTimeout(timer); resolve(false); };
        timer = setTimeout(() => { waiting = null; resolve(true); }, idle);
      });
      if (timedOut) { kill(); throw new ProviderError(`no output for ${Math.round(idle / 1000)}s`, "timeout"); }
    }
    while (queue.length) yield queue.shift()!;
    if (spawnError) throw new ProviderError(`cannot start ${path.basename(opts.exe)}: ${(spawnError as Error).message}`, "not_found");
    if (exitCode !== 0 && exitCode !== null) {
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      throw new ProviderError(`${path.basename(opts.exe)} exited with code ${exitCode}${tail ? ": " + tail : ""}`, classifyStderr(tail));
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (!ended) kill();
  }
}

function classifyStderr(text: string): ProviderError["code"] {
  const t = text.toLowerCase();
  if (/not logged in|login|unauthorized|authentication|api key/.test(t)) return "auth";
  if (/rate limit|429|usage limit|quota/.test(t)) return "rate_limit";
  if (/network|econn|enotfound|timeout/.test(t)) return "network";
  return "unknown";
}

/** Flattens a chat transcript into one prompt body for CLIs that take a single prompt string. */
export function transcriptPrompt(messages: ChatMessage[], selfName: string): string {
  const parts: string[] = [];
  for (const m of messages) parts.push(m.role === "assistant" ? `[${selfName}]: ${m.content}` : m.content);
  return parts.join("\n\n");
}
