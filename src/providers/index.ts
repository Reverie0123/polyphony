// Provider registry. Tests register a fake provider here so the whole pipeline runs without spending money.
import type { Account } from "../models.js";
import type { ChatFn } from "./types.js";
import { chatOpenAI } from "./openai.js";
import { chatAnthropic } from "./anthropic.js";
import { chatOllama } from "./ollama.js";
import { chatClaudeCli } from "./cli-claude.js";
import { chatCodexCli } from "./cli-codex.js";

const registry = new Map<string, ChatFn>([
  ["openai", chatOpenAI],
  ["anthropic", chatAnthropic],
  ["ollama", chatOllama],
  ["cli:claude", chatClaudeCli],
  ["cli:codex", chatCodexCli],
]);

export function providerKey(account: Account): string {
  return account.provider === "cli" ? `cli:${account.cliKind ?? "claude"}` : account.provider;
}

export function getChatFn(account: Account): ChatFn | undefined {
  return registry.get(providerKey(account));
}

export function registerProvider(key: string, fn: ChatFn): void {
  registry.set(key, fn);
}

export { ProviderError } from "./types.js";
export type { ChatEvent, ChatFn, ChatRequest, ChatMessage, ProviderContext, ToolDef } from "./types.js";
