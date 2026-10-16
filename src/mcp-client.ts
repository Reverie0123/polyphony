// Minimal MCP client over stdio: enough of JSON-RPC 2.0 to initialize, list tools and call them. No dependencies.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  onExit?: (code: number | null) => void;
  onLog?: (line: string) => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class McpClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private closed = false;
  serverInfo: { name?: string; version?: string } = {};
  instructions = "";
  tools: McpTool[] = [];

  constructor(private opts: McpClientOptions) {}

  get alive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.closed;
  }

  async start(): Promise<void> {
    const exe = this.opts.command;
    const args = this.opts.args ?? [];
    const useCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
    this.child = useCmd
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${exe}" ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ")}`], { cwd: this.opts.cwd, env: this.opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(exe, args, { cwd: this.opts.cwd, env: this.opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const child = this.child;
    child.stdout?.on("data", (d: Buffer) => this.onData(d));
    child.stderr?.on("data", (d: Buffer) => { for (const line of d.toString("utf8").split("\n")) if (line.trim()) this.opts.onLog?.(line); });
    child.on("error", (e) => this.failAll(new Error(`cannot start ${path.basename(exe)}: ${e.message}`)));
    child.on("close", (code) => { this.failAll(new Error(`MCP server exited with code ${code}`)); this.opts.onExit?.(code); });
    try {
      const init = (await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: this.opts.clientName ?? "polyphony", version: this.opts.clientVersion ?? "0.1.0" },
      })) as { serverInfo?: { name?: string; version?: string }; instructions?: string };
      this.serverInfo = init.serverInfo ?? {};
      this.instructions = init.instructions ?? "";
      this.notify("notifications/initialized", {});
      await this.refreshTools();
    } catch (err) {
      // A child that started but never answered initialize would otherwise live on as an orphan.
      this.close();
      throw err;
    }
  }

  async refreshTools(): Promise<McpTool[]> {
    const all: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpTool[]; nextCursor?: string };
      all.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor);
    this.tools = all;
    return all;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpCallResult;
    return { content: r.content ?? [], isError: r.isError, structuredContent: r.structuredContent };
  }

  close(): void {
    this.closed = true;
    const c = this.child;
    this.child = null;
    try { c?.stdin?.end(); } catch { /* ignore */ }
    try { c?.kill(); } catch { /* ignore */ }
    if (process.platform === "win32" && c?.pid) {
      // A .cmd shim leaves the real process behind; kill the whole tree.
      try { spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).unref(); } catch { /* ignore */ }
    }
    this.failAll(new Error("MCP client closed"));
  }

  private request(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 120000): Promise<unknown> {
    if (!this.child || !this.child.stdin) return Promise.reject(new Error("MCP client not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    try { this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); } catch { /* ignore */ }
  }

  private onData(d: Buffer): void {
    this.buf += d.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith("{")) { if (line) this.opts.onLog?.(line); continue; }
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.method === "ping" && msg.id !== undefined) {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
      } else if (msg.method && msg.id !== undefined) {
        // sampling, roots, elicitation: not supported by this minimal client; answer so the server does not wait forever.
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } }) + "\n");
      }
      // Other server notifications (logging, list_changed) are ignored in this minimal client.
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}
