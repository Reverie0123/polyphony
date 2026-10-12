import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOpenAIChunk, usageFromOpenAI } from "../dist/providers/openai.js";
import { parseAnthropicEvent, newParseState } from "../dist/providers/anthropic.js";
import { parseOllamaLine } from "../dist/providers/ollama.js";
import { parseClaudeLine } from "../dist/providers/cli-claude.js";
import { parseCodexLine } from "../dist/providers/cli-codex.js";

test("OpenAI chunks: text, reasoning, DeepSeek cache field, finish", () => {
  const buf = new Map();
  const ev1 = parseOpenAIChunk(JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] }), buf);
  assert.deepEqual(ev1, [{ type: "reasoning", text: "think" }]);
  const ev2 = parseOpenAIChunk(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }), buf);
  assert.deepEqual(ev2, [{ type: "delta", text: "hi" }]);
  const ev3 = parseOpenAIChunk(JSON.stringify({ model: "deepseek-chat", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100 } }), buf);
  const usage = ev3.find((e) => e.type === "usage").usage;
  assert.equal(usage.input, 20);
  assert.equal(usage.cacheRead, 100);
  assert.equal(usage.output, 30);
  assert.equal(ev3.find((e) => e.type === "done").model, "deepseek-chat");
});

test("OpenAI usage: OpenAI-style cached_tokens and reasoning tokens", () => {
  const u = usageFromOpenAI({ prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 6 } });
  assert.deepEqual(u, { input: 10, output: 10, cacheRead: 40, cacheWrite: 0, reasoning: 6, estimated: false });
});

test("OpenAI tool call fragments are accumulated by index", () => {
  const buf = new Map();
  parseOpenAIChunk(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "click", arguments: "{\"x\":" } }] } }] }), buf);
  parseOpenAIChunk(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] }), buf);
  assert.deepEqual(buf.get(0), { id: "call_1", name: "click", args: "{\"x\":1}" });
});

test("Anthropic events: usage from message_start and message_delta, text, tool_use", () => {
  const st = newParseState();
  parseAnthropicEvent(JSON.stringify({ type: "message_start", message: { model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } } }), st);
  const t1 = parseAnthropicEvent(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hey" } }), st);
  assert.deepEqual(t1, [{ type: "delta", text: "Hey" }]);
  parseAnthropicEvent(JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "list_windows" } }), st);
  parseAnthropicEvent(JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"a\":" } }), st);
  parseAnthropicEvent(JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } }), st);
  const stop = parseAnthropicEvent(JSON.stringify({ type: "content_block_stop", index: 1 }), st);
  assert.deepEqual(stop, [{ type: "tool_call", id: "tu_1", name: "list_windows", args: "{\"a\":1}" }]);
  const end = parseAnthropicEvent(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }), st);
  const usage = end.find((e) => e.type === "usage").usage;
  assert.deepEqual(usage, { input: 10, output: 7, cacheRead: 90, cacheWrite: 5, reasoning: 0, estimated: false });
  assert.equal(end.find((e) => e.type === "done").finish, "end_turn");
});

test("Ollama lines: content then done with counts", () => {
  assert.deepEqual(parseOllamaLine(JSON.stringify({ message: { role: "assistant", content: "yo" }, done: false })), [{ type: "delta", text: "yo" }]);
  const end = parseOllamaLine(JSON.stringify({ model: "qwen3", message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 3 }));
  assert.equal(end[0].type, "usage");
  assert.equal(end[0].usage.input, 12);
  assert.equal(end[1].type, "done");
});

test("claude stream-json: partial deltas then result with usage", () => {
  const st = { sawDelta: false, assistantText: "" };
  const d = parseClaudeLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }), st);
  assert.deepEqual(d, [{ type: "delta", text: "Hel" }]);
  parseClaudeLine(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "Hello" }] } }), st);
  const r = parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", result: "Hello", usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, total_cost_usd: 0.001 }), st);
  assert.equal(r.filter((e) => e.type === "delta").length, 0, "no duplicate text when deltas were streamed");
  assert.equal(r.find((e) => e.type === "usage").usage.cacheRead, 100);
  assert.equal(r.find((e) => e.type === "done").model, "claude-opus-5-5");
});

test("claude stream-json without partial messages falls back to the assistant text", () => {
  const st = { sawDelta: false, assistantText: "" };
  parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Whole" }] } }), st);
  const r = parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", result: "Whole", usage: {} }), st);
  assert.deepEqual(r[0], { type: "delta", text: "Whole" });
});

test("codex JSONL: agent_message then turn.completed", () => {
  const st = { text: "", emitted: false };
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "x" }), st), []);
  const m = parseCodexLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }), st);
  assert.deepEqual(m, [{ type: "delta", text: "Done." }]);
  const end = parseCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 9 } }), st);
  assert.deepEqual(end[0].usage, { input: 30, output: 9, cacheRead: 20, cacheWrite: 0, reasoning: 0, estimated: false });
  assert.equal(end[1].type, "done");
  assert.throws(() => parseCodexLine(JSON.stringify({ type: "error", message: "not logged in" }), st), /not logged in/);
});
