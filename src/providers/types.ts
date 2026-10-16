// One interface for every way of reaching a model. A provider turns a request into an async stream of events.
import type { Account, Usage } from "../models.js";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text of the arguments. */
  args: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Tool turns: which call this result answers. */
  toolCallId?: string;
  /** Images inside a tool result (screenshots), sent only to vision-capable models. */
  images?: ImageInput[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ImageInput {
  mime: string;
  /** Base64 without a data: prefix. */
  data: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  /** Images attached to the last user message (vision requests only). */
  images?: ImageInput[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  /** Mark the system prompt as cacheable where the provider supports it. */
  cacheSystem?: boolean;
  signal?: AbortSignal;
  /** Milliseconds to wait for the first byte of the reply. */
  firstByteTimeoutMs?: number;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finish?: string; model?: string }
  | { type: "status"; text: string };

export interface ProviderContext {
  account: Account;
  key: string;
  /** Working directory for cli subprocesses. */
  cliCwd: string;
}

export type ChatFn = (ctx: ProviderContext, req: ChatRequest) => AsyncGenerator<ChatEvent, void, void>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: "auth" | "rate_limit" | "server" | "network" | "timeout" | "refused" | "bad_request" | "cancelled" | "not_found" | "empty_reply" | "unknown",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Turns any error raised while reading a body into a ProviderError with the right code. */
export function streamError(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) return new ProviderError("cancelled", "cancelled");
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError") return new ProviderError("the stream stalled", "timeout");
  if (e?.name === "AbortError") return new ProviderError("the stream was cut off", "network");
  return new ProviderError(e?.message || "network error while reading the reply", "network");
}

/** Reads an SSE / NDJSON body line by line; yields each non-empty line without the trailing newline. */
export async function* readLines(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) throw new ProviderError("cancelled", "cancelled");
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (err) { throw streamError(err, signal); }
      const { value, done } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.length) yield line;
      }
    }
    buf += decoder.decode();
    if (buf.trim().length) yield buf.replace(/\r$/, "");
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * Consumes a provider stream with an idle timeout (no event for idleMs) and a total cap (totalMs). On either, the
 * controller is aborted and a ProviderError("timeout") is thrown, even if the underlying generator never yields again.
 */
export async function* withWatchdog<T>(source: AsyncGenerator<T>, controller: AbortController, idleMs: number, totalMs: number, onTimeout?: () => void): AsyncGenerator<T> {
  const started = Date.now();
  while (true) {
    const budget = Math.min(idleMs, Math.max(0, totalMs - (Date.now() - started)));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budget); });
    let result: IteratorResult<T> | "timeout";
    try {
      result = await Promise.race([source.next(), timeout]);
    } finally {
      // A rejected next() must not leave the (up to several minutes long) timer holding the process open.
      clearTimeout(timer);
    }
    if (result === "timeout") {
      onTimeout?.();
      controller.abort();
      void source.return(undefined).catch(() => undefined);
      const idle = Date.now() - started < totalMs;
      throw new ProviderError(idle ? `no data from the provider for ${Math.round(idleMs / 1000)}s` : `the reply exceeded ${Math.round(totalMs / 60000)} minutes`, "timeout");
    }
    if (result.done) return;
    yield result.value;
  }
}

/** Maps an HTTP status to a ProviderError with a user-facing code. */
export function httpError(status: number, detail: string): ProviderError {
  const short = detail.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError(short || "authentication failed", "auth", status);
  if (status === 404) return new ProviderError(short || "not found", "not_found", status);
  if (status === 429) return new ProviderError(short || "rate limited", "rate_limit", status);
  if (status >= 500) return new ProviderError(short || "server error", "server", status);
  return new ProviderError(short || `HTTP ${status}`, "bad_request", status);
}

/**
 * fetch with a first-byte timeout and the caller's abort signal; network failures become ProviderError.
 * The timeout only covers the wait for the response headers. Once they arrive it is cleared, so a long reply
 * (a reasoning model thinking for minutes) is never cut off; only the caller's signal can abort the body.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal | undefined, firstByteMs: number): Promise<Response> {
  if (signal?.aborted) throw new ProviderError("cancelled", "cancelled");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, firstByteMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw new ProviderError("cancelled", "cancelled");
    if (timedOut) throw new ProviderError(`no response within ${Math.round(firstByteMs / 1000)}s`, "timeout");
    throw new ProviderError((err as Error).message || "network error", "network");
  }
}
