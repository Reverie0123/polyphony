#!/usr/bin/env node
// Entry point: single instance, port, tokens, HTTP server, browser window, auto exit.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store, dataDir, writeJsonAtomic } from "./store.js";
import { Pricing } from "./pricing.js";
import { Engine } from "./engine.js";
import { Attachments } from "./attachments.js";
import { Vision } from "./vision.js";
import { Summarizer } from "./summary.js";
import { Orchestrator } from "./orchestrator.js";
import { DeskDock } from "./deskdock.js";
import { Updater } from "./updater.js";
import { createApp } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

interface TokenFile { schemaVersion: number; token: string; lanToken?: string; createdAt: string }

export function loadOrCreateToken(dir: string, reset = false): TokenFile {
  const file = path.join(dir, "token.json");
  if (!reset && existsSync(file)) {
    try {
      const t = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
      if (t.token) return t;
    } catch { /* regenerate */ }
  }
  const t: TokenFile = { schemaVersion: 1, token: randomBytes(24).toString("base64url"), createdAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(file, t);
  return t;
}

function uiLang(store: Store): "zh" | "en" {
  const s = store.getSettings().lang;
  if (s === "zh" || s === "en") return s;
  const l = (process.env.POLYPHONY_LANG ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale ?? "").toLowerCase();
  return l.startsWith("zh") ? "zh" : "en";
}

async function alreadyRunning(dir: string): Promise<{ port: number; url: string } | null> {
  const file = path.join(dir, "instance.json");
  if (!existsSync(file)) return null;
  try {
    const inst = JSON.parse(readFileSync(file, "utf8")) as { port: number; pid: number };
    const res = await fetch(`http://127.0.0.1:${inst.port}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = (await res.json()) as { app?: string };
    if (j.app !== "polyphony") return null;
    return { port: inst.port, url: `http://127.0.0.1:${inst.port}/` };
  } catch {
    return null;
  }
}

function findEdge(): string | undefined {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  return candidates.find((c) => c && existsSync(c));
}

/** Opens the page as an app window (no address bar) in Edge, with its own profile so it works while Edge is already open. */
export function openWindow(url: string, dir: string): void {
  if (process.platform === "win32") {
    const edge = findEdge();
    if (edge) {
      const profile = path.join(dir, "edge-profile");
      mkdirSync(profile, { recursive: true });
      spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,820"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return;
    }
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function listen(server: import("node:http").Server, host: string, ports: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      if (i >= ports.length) return reject(new Error(`no free port in ${ports[0]}-${ports[ports.length - 1]}`));
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE" || err.code === "EACCES") tryPort(i + 1);
        else reject(err);
      };
      server.once("error", onError);
      server.listen(ports[i], host, () => {
        server.removeListener("error", onError);
        resolve(ports[i]);
      });
    };
    tryPort(0);
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = arg("--data-dir") ?? dataDir();
  const version = readVersion();
  if (argv.includes("--version")) { console.log(version); return; }
  if (argv.includes("--help")) {
    console.log(`Polyphony ${version}\n  polyphony            start and open the window\n  --no-open            start without opening a window\n  --port <n>           port (default from settings, 7331)\n  --data-dir <path>    data directory (default %APPDATA%\\Polyphony or POLYPHONY_HOME)\n  --reset-token        issue a new token`);
    return;
  }

  const running = await alreadyRunning(dir);
  const tokens = loadOrCreateToken(dir, argv.includes("--reset-token"));
  if (running && !argv.includes("--force")) {
    if (!argv.includes("--no-open")) openWindow(`${running.url}?token=${encodeURIComponent(tokens.token)}`, dir);
    console.log(`Polyphony is already running at ${running.url}`);
    return;
  }

  const store = new Store(dir);
  const pricing = new Pricing(dir);
  const settings = store.getSettings();
  const lanToken = settings.lanAccess ? (tokens.lanToken ?? randomBytes(16).toString("base64url")) : undefined;
  if (settings.lanAccess) { tokens.lanToken = lanToken; writeJsonAtomic(path.join(dir, "token.json"), tokens); }

  let clients = 0;
  let idleSince = Date.now();
  const lang = () => uiLang(store);
  const broadcast = (e: string, d: unknown) => hub.broadcast(e, d);
  const engine = new Engine({ store, pricing, broadcast, lang });
  const attachments = new Attachments(dir);
  const summarizer = new Summarizer({ store, pricing, broadcast, lang, call: engine.callContact });
  const vision = new Vision({ store, pricing, attachments, broadcast, lang, call: engine.callContact });
  const deskdock = new DeskDock({ store, pricing, broadcast, lang });
  const orchestrator = new Orchestrator({ store, engine, broadcast, lang, runDeskdock: (s, m) => deskdock.runTask(s, m) });
  engine.afterReply = (s, m) => { void summarizer.maybeRun(s); void orchestrator.onReply(s, m); };
  for (const meta of store.listSessions()) { const s = store.getSession(meta.id); if (s) orchestrator.recover(s); }
  const updater = new Updater(version);
  const restart = () => {
    // Relaunch the same entry detached, then leave; the new process takes over the port once this one closes.
    deskdock.restart();
    server.close();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== "--force"), "--force"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    setTimeout(() => process.exit(0), 200);
  };
  const resetToken = () => {
    const fresh = loadOrCreateToken(dir, true);
    if (tokens.lanToken) { fresh.lanToken = tokens.lanToken; writeJsonAtomic(path.join(dir, "token.json"), fresh); }
    tokens.token = fresh.token;
    return fresh.token;
  };
  const { server, hub } = createApp({
    store, pricing, engine, attachments, vision, summarizer, orchestrator, deskdock, updater, restart, resetToken, token: tokens.token, lanToken, version,
    onClients: (n) => { clients = n; if (n === 0) idleSince = Date.now(); },
  });

  const basePort = Number(arg("--port")) || settings.port || 7331;
  const ports = Array.from({ length: 10 }, (_, i) => basePort + i);
  const host = settings.lanAccess ? "0.0.0.0" : "127.0.0.1";
  const port = await listen(server, host, ports);
  const url = `http://127.0.0.1:${port}/`;
  writeJsonAtomic(path.join(dir, "instance.json"), { port, pid: process.pid, started: new Date().toISOString(), version });
  console.log(`Polyphony ${version} listening on ${url}  data: ${dir}`);
  if (!argv.includes("--no-open")) openWindow(`${url}?token=${encodeURIComponent(tokens.token)}`, dir);

  // Price refresh and update check in the background.
  void pricing.refreshOnline(store.listContacts().map((c) => c.model).filter(Boolean));
  if (settings.checkUpdates && !argv.includes("--no-update-check")) {
    setTimeout(() => { void updater.check().then((info) => { if (info.hasUpdate) hub.broadcast("update.available", info); }); }, 3000).unref();
  }

  // Auto exit: no connected page for N minutes and nothing running.
  const timer = setInterval(() => {
    const minutes = store.getSettings().autoExitMinutes;
    if (minutes <= 0 || argv.includes("--no-exit")) return;
    if (clients === 0 && engine.busy + summarizer.busy + vision.busy + orchestrator.busy + deskdock.busy === 0 && Date.now() - idleSince > minutes * 60000) {
      console.log("no page connected; exiting");
      deskdock.restart();
      server.close();
      clearInterval(timer);
      process.exit(0);
    }
  }, 30000);
  timer.unref();

  const shutdown = () => { deskdock.restart(); server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
