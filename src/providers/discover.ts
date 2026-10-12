// Model discovery for the add-contact wizard: pull the list instead of making the user type model ids.
import type { Account } from "../models.js";
import { fetchWithTimeout, httpError } from "./types.js";

export interface DiscoveredModel {
  id: string;
  name?: string;
}

export async function discoverModels(account: Account, key: string): Promise<DiscoveredModel[]> {
  const base = account.baseURL.replace(/\/+$/, "");
  if (account.provider === "openai") {
    const res = await fetchWithTimeout(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } }, undefined, 20000);
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
    const j = (await res.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  }
  if (account.provider === "anthropic") {
    const res = await fetchWithTimeout(`${base || "https://api.anthropic.com"}/v1/models?limit=100`, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }, undefined, 20000);
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
    const j = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
  }
  if (account.provider === "ollama") {
    const res = await fetchWithTimeout(`${base || "http://127.0.0.1:11434"}/api/tags`, {}, undefined, 10000);
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
    const j = (await res.json()) as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => ({ id: m.name }));
  }
  if (account.provider === "cli") {
    // No listing endpoint; offer the aliases each CLI understands plus "default".
    return account.cliKind === "claude"
      ? [{ id: "", name: "default" }, { id: "opus" }, { id: "sonnet" }, { id: "haiku" }]
      : [{ id: "", name: "default" }, { id: "gpt-5.5" }, { id: "gpt-5.5-codex" }, { id: "gpt-5.1-codex-mini" }];
  }
  return [];
}
