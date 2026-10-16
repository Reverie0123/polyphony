// Atomic write retry, ledger rotation, and the claude system-prompt temp file cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Store, writeJsonAtomic, hasPendingWrite } from "../dist/store.js";
import { chatClaudeCli } from "../dist/providers/cli-claude.js";
import { tempDir } from "./helpers.mjs";

test("writeJsonAtomic keeps renaming: a locked target is replaced a moment later, never copied over", async () => {
  if (process.platform !== "win32") return;
  const { dir, cleanup } = tempDir();
  try {
    const file = path.join(dir, "locked.json");
    writeFileSync(file, JSON.stringify({ v: 1 }));
    // Hold the file open with no sharing for 500 ms, the way a scanner or editor would.
    const holder = spawn("powershell.exe", ["-NoProfile", "-Command", `$f=[IO.File]::Open('${file}','Open','Read','None'); Start-Sleep -Milliseconds 500; $f.Close()`], { stdio: "ignore", windowsHide: true });
    await new Promise((r) => setTimeout(r, 250));
    writeJsonAtomic(file, { v: 2 });
    const deferred = hasPendingWrite(file);
    // While the holder keeps the exclusive lock the file cannot even be read; the point is that nothing was copied over it.
    if (!deferred) assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 2);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 2, "the retry landed");
    assert.equal(hasPendingWrite(file), false);
    assert.equal(existsSync(file + ".tmp"), false);
    holder.kill();
  } finally {
    cleanup();
  }
});

test("ledger rotation: old entries move to the archive and fold into totals; summaries still include them", () => {
  const { dir, cleanup } = tempDir();
  try {
    const entry = (daysAgo, sessionId, usd) => ({ at: new Date(Date.now() - daysAgo * 86400000).toISOString(), sessionId, messageId: "m", contactId: "c", accountId: "a", provider: "openai", model: "x", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false }, cost: { usd, cny: usd * 7, priced: true, kind: "metered" }, purpose: "reply" });
    const first = new Store(dir);
    first.appendLedger(entry(60, "old", 1));
    first.appendLedger(entry(45, "old", 2));
    first.appendLedger(entry(0, "new", 4));
    const store = new Store(dir);
    const live = store.readLedger();
    assert.equal(live.length, 1, "only the recent entry stays live");
    assert.ok(existsSync(path.join(dir, "ledger-archive.jsonl")));
    assert.equal(readFileSync(path.join(dir, "ledger-archive.jsonl"), "utf8").trim().split("\n").length, 2);
    const totals = JSON.parse(readFileSync(path.join(dir, "ledger-totals.json"), "utf8"));
    assert.equal(totals.allUsd, 3);
    const sum = store.ledgerSummary("old");
    assert.equal(sum.allUsd, 7);
    assert.equal(sum.sessionUsd, 3, "archived session total still reported");
    assert.equal(sum.todayUsd, 4);
    assert.equal(sum.byProvider.openai.calls, 3);
    store.appendLedger(entry(0, "new", 1));
    assert.equal(store.ledgerSummary("new").sessionUsd, 5);
    // A second load does not archive twice.
    const again = new Store(dir);
    assert.equal(again.ledgerSummary("old").allUsd, 8);
  } finally {
    cleanup();
  }
});

test("claude: the temporary system-prompt file is removed even when the CLI fails", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const cwd = path.join(dir, "cli-cwd");
    mkdirSync(cwd);
    // Point the "claude" executable at node itself: it rejects the arguments and exits non-zero.
    const ctx = { account: { provider: "cli", cliKind: "claude", cliPath: process.execPath }, key: "", cliCwd: cwd };
    await assert.rejects(async () => { for await (const _ of chatClaudeCli(ctx, { model: "", system: "你是测试", messages: [{ role: "user", content: "hi" }] })) { /* drain */ } });
    assert.equal(readdirSync(cwd).filter((f) => f.startsWith("system-")).length, 0, "no leftover system-*.txt");
  } finally {
    cleanup();
  }
});
