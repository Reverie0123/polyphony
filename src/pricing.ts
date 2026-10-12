// Price table and cost estimation. USD per million tokens; input / output / cacheRead / cacheWrite.
// Built-in prices are a snapshot (2026-09/10); the online LiteLLM table refreshes them, user overrides win over both.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Cost, Provider, Usage } from "./models.js";
import { writeJsonAtomic } from "./store.js";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const BUILTIN_PRICES: Record<string, Price> = {
  // Anthropic (first-party API rates; cache read 0.1x, cache write 1.25x).
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // DeepSeek (official, USD; cache hit is one tenth of a miss).
  "deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  "deepseek-reasoner": { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
  // OpenAI.
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  "o3": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
};

/** Strips provider prefixes, date suffixes and "-latest" so "anthropic/claude-opus-5-5-20260401" matches "claude-opus-5-5". */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/@.*$/, "");
  m = m.replace(/-20\d{6}$/, "");
  m = m.replace(/-latest$/, "");
  return m;
}

export const LITELLM_URL = "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json";

interface PricingFile {
  schemaVersion: number;
  overrides: Record<string, Price>;
  online: Record<string, Price>;
  onlineFetchedAt: string | null;
}

export class Pricing {
  private file: string;
  private data: PricingFile;

  constructor(dir: string) {
    this.file = path.join(dir, "pricing.json");
    this.data = { schemaVersion: 1, overrides: {}, online: {}, onlineFetchedAt: null };
    if (existsSync(this.file)) {
      try { this.data = { ...this.data, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<PricingFile>) }; } catch { /* keep defaults */ }
    }
  }

  lookup(provider: Provider, model: string): Price | undefined {
    if (provider === "ollama" || provider === "cli") return undefined;
    const n = normalizeModel(model);
    return this.data.overrides[n] ?? this.data.online[n] ?? BUILTIN_PRICES[n];
  }

  /** Every model this table knows, for the settings page. */
  table(): { model: string; price: Price; source: "override" | "online" | "builtin" }[] {
    const seen = new Map<string, { model: string; price: Price; source: "override" | "online" | "builtin" }>();
    for (const [m, p] of Object.entries(BUILTIN_PRICES)) seen.set(m, { model: m, price: p, source: "builtin" });
    for (const [m, p] of Object.entries(this.data.online)) seen.set(m, { model: m, price: p, source: "online" });
    for (const [m, p] of Object.entries(this.data.overrides)) seen.set(m, { model: m, price: p, source: "override" });
    return [...seen.values()].sort((a, b) => a.model.localeCompare(b.model));
  }

  setOverride(model: string, price: Price | null): void {
    const n = normalizeModel(model);
    if (price) this.data.overrides[n] = price; else delete this.data.overrides[n];
    this.save();
  }

  get onlineFetchedAt(): string | null {
    return this.data.onlineFetchedAt;
  }

  /**
   * Refreshes prices from the LiteLLM table, keeping only models the app knows about so the file stays small.
   * Called at most once a day; failures are silent and leave the previous data in place.
   */
  async refreshOnline(knownModels: string[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const last = this.data.onlineFetchedAt ? Date.parse(this.data.onlineFetchedAt) : 0;
    if (Date.now() - last < 24 * 3600 * 1000) return false;
    try {
      const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return false;
      const raw = (await res.json()) as Record<string, Record<string, unknown>>;
      const wanted = new Set([...knownModels.map(normalizeModel), ...Object.keys(BUILTIN_PRICES)]);
      const online: Record<string, Price> = {};
      for (const [key, v] of Object.entries(raw)) {
        const n = normalizeModel(key);
        if (!wanted.has(n) || online[n]) continue;
        const inp = num(v.input_cost_per_token);
        const out = num(v.output_cost_per_token);
        if (inp === undefined || out === undefined) continue;
        online[n] = {
          input: inp * 1e6,
          output: out * 1e6,
          cacheRead: (num(v.cache_read_input_token_cost) ?? inp) * 1e6,
          cacheWrite: (num(v.cache_creation_input_token_cost) ?? inp) * 1e6,
        };
      }
      this.data.online = online;
      this.data.onlineFetchedAt = new Date().toISOString();
      this.save();
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function computeCost(provider: Provider, usage: Usage, price: Price | undefined, usdToCny: number): Cost {
  if (provider === "cli") return { usd: 0, cny: 0, priced: false, kind: "subscription" };
  if (provider === "ollama") return { usd: 0, cny: 0, priced: true, kind: "free" };
  if (!price) return { usd: 0, cny: 0, priced: false, kind: "metered" };
  const usd =
    (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1e6;
  return { usd, cny: usd * usdToCny, priced: true, kind: "metered" };
}

/** Estimated cost of a request before it is sent, for the privacy line. */
export function estimateRequestCost(provider: Provider, inputTokens: number, expectedOutputTokens: number, price: Price | undefined, usdToCny: number): Cost {
  return computeCost(provider, { input: inputTokens, output: expectedOutputTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: true }, price, usdToCny);
}
