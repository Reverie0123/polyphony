import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel, computeCost, Pricing, BUILTIN_PRICES } from "../dist/pricing.js";
import { tempDir } from "./helpers.mjs";

test("normalizeModel strips prefixes, dates and suffixes", () => {
  assert.equal(normalizeModel("anthropic/claude-opus-5-5-20260401"), "claude-opus-5-5");
  assert.equal(normalizeModel("Claude-Sonnet-4-6@20260301"), "claude-sonnet-4-6");
  assert.equal(normalizeModel("deepseek-chat"), "deepseek-chat");
  assert.equal(normalizeModel("gpt-4o-latest"), "gpt-4o");
});

test("computeCost applies the four price tiers and the exchange rate", () => {
  const price = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
  const usage = { input: 1_000_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 0, estimated: false };
  const c = computeCost("openai", usage, price, 7);
  assert.equal(c.priced, true);
  assert.equal(c.kind, "metered");
  assert.ok(Math.abs(c.usd - 2.1) < 1e-9);
  assert.ok(Math.abs(c.cny - 14.7) < 1e-9);
});

test("computeCost marks ollama free, cli subscription, unknown model unpriced", () => {
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false };
  assert.equal(computeCost("ollama", usage, undefined, 7).kind, "free");
  assert.equal(computeCost("cli", usage, undefined, 7).kind, "subscription");
  const u = computeCost("openai", usage, undefined, 7);
  assert.equal(u.priced, false);
  assert.equal(u.usd, 0);
});

test("Pricing lookup prefers override over builtin and persists it", () => {
  const { dir, cleanup } = tempDir();
  try {
    const p = new Pricing(dir);
    assert.deepEqual(p.lookup("openai", "deepseek-chat"), BUILTIN_PRICES["deepseek-chat"]);
    p.setOverride("DeepSeek-Chat", { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 });
    assert.equal(p.lookup("openai", "deepseek-chat").input, 9);
    const again = new Pricing(dir);
    assert.equal(again.lookup("openai", "deepseek-chat").output, 9);
    assert.equal(again.table().find((r) => r.model === "deepseek-chat").source, "override");
    assert.equal(p.lookup("ollama", "llama3"), undefined);
  } finally {
    cleanup();
  }
});

test("Pricing.refreshOnline keeps only known models and converts per-token prices", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const p = new Pricing(dir);
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        "some-unknown-model": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
        "my-model": { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6, cache_read_input_token_cost: 1e-6 },
      }),
    });
    assert.equal(await p.refreshOnline(["my-model"], fakeFetch), true);
    assert.deepEqual(p.lookup("openai", "my-model"), { input: 3, output: 4, cacheRead: 1, cacheWrite: 3 });
    assert.equal(p.lookup("openai", "some-unknown-model"), undefined);
    assert.equal(await p.refreshOnline(["my-model"], fakeFetch), false, "second call within a day is skipped");
  } finally {
    cleanup();
  }
});
