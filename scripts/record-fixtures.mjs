// Records raw provider streams into tests/fixtures so the parsers can be tested without spending money again.
// Usage (keys from the app's own accounts): node scripts/record-fixtures.mjs [--data-dir <dir>]
// Writes tests/fixtures/<provider>-<model>.txt with the raw SSE / NDJSON body of one short request.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const dataDir = arg("--data-dir") ?? process.env.POLYPHONY_HOME ?? path.join(process.env.APPDATA ?? "", "Polyphony");
const accounts = JSON.parse(readFileSync(path.join(dataDir, "accounts.json"), "utf8")).items;
const keys = JSON.parse(readFileSync(path.join(dataDir, "keys.json"), "utf8")).keys;
const contacts = JSON.parse(readFileSync(path.join(dataDir, "contacts.json"), "utf8")).items;
const outDir = path.resolve("tests/fixtures");
mkdirSync(outDir, { recursive: true });

// Local CLIs: their JSON formats change with every release, so their raw stdout is worth keeping too.
import { spawnSync } from "node:child_process";
for (const kind of ["claude", "codex"]) {
  if (!accounts.some((a) => a.provider === "cli" && a.cliKind === kind)) continue;
  const file = path.join(outDir, `cli-${kind}.txt`);
  if (existsSync(file)) { console.log("skip (exists)", path.basename(file)); continue; }
  const args = kind === "claude"
    ? ["-p", "--bare", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--tools", "", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    : ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--color", "never", "-"];
  const exe = kind === "codex" && process.platform === "win32" ? "codex.cmd" : kind;
  const r = spawnSync(exe, args, { input: "用五个字以内打个招呼。", encoding: "utf8", shell: exe.endsWith(".cmd"), timeout: 120000, cwd: path.join(dataDir, "cli-cwd") });
  writeFileSync(file, `# ${kind} exit ${r.status}\n` + (r.stdout ?? "") + (r.stderr ? "\n# stderr\n" + r.stderr : ""), "utf8");
  console.log("recorded", path.basename(file), "exit", r.status, (r.stdout ?? "").length, "bytes");
}

for (const c of contacts) {
  const a = accounts.find((x) => x.id === c.accountId);
  if (!a || a.provider === "cli" || !c.model) continue;
  const name = `${a.provider}-${c.model.replace(/[^a-z0-9.-]/gi, "_")}.txt`;
  const file = path.join(outDir, name);
  if (existsSync(file)) { console.log("skip (exists)", name); continue; }
  let url, headers, body;
  const base = a.baseURL.replace(/\/+$/, "");
  if (a.provider === "openai") {
    url = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${keys[a.id]}` };
    body = { model: c.model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "用五个字以内打个招呼。" }], max_tokens: 50 };
  } else if (a.provider === "anthropic") {
    url = `${base || "https://api.anthropic.com"}/v1/messages`;
    headers = { "Content-Type": "application/json", "x-api-key": keys[a.id], "anthropic-version": "2023-06-01" };
    body = { model: c.model, stream: true, max_tokens: 50, messages: [{ role: "user", content: "用五个字以内打个招呼。" }] };
  } else if (a.provider === "ollama") {
    url = `${base || "http://127.0.0.1:11434"}/api/chat`;
    headers = { "Content-Type": "application/json" };
    body = { model: c.model, stream: true, messages: [{ role: "user", content: "用五个字以内打个招呼。" }] };
  } else continue;
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    writeFileSync(file, `# ${a.provider} ${c.model} HTTP ${res.status}\n` + text, "utf8");
    console.log("recorded", name, res.status, text.length, "bytes");
  } catch (e) {
    console.log("failed", name, e.message);
  }
}
