// One interface for every way of reaching a model. A provider turns a request into an async stream of events.
import type { Account, Usage } from "../models.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
    readonly code: "auth" | "rate_limit" | "server" | "network" | "timeout" | "refused" | "bad_request" | "cancelled" | "not_found" | "unknown",
    readonly status?: number,
  ) {
    super(message);
  }
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
      const { value, done } = await reader.read();
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

/** Maps an HTTP status to a ProviderError with a user-facing code. */
export function httpError(status: number, detail: string): ProviderError {
  const short = detail.slice(0, 300);
  if (status === 401 || status === 403) return new ProviderError(short || "authentication failed", "auth", status);
  if (status === 404) return new ProviderError(short || "not found", "not_found", status);
  if (status === 429) return new ProviderError(short || "rate limited", "rate_limit", status);
  if (status >= 500) return new ProviderError(short || "server error", "server", status);
  return new ProviderError(short || `HTTP ${status}`, "bad_request", status);
}

/** fetch with a first-byte timeout and the caller's abort signal; network failures become ProviderError. */
export async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal | undefined, firstByteMs: number): Promise<Response> {
  const timeout = AbortSignal.timeout(firstByteMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError("cancelled", "cancelled");
    if (timeout.aborted) throw new ProviderError(`no response within ${Math.round(firstByteMs / 1000)}s`, "timeout");
    throw new ProviderError((err as Error).message || "network error", "network");
  }
}
