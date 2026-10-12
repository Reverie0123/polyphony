// Update check against the npm registry (npmmirror first for China, then npmjs). Three install kinds take
// three paths: global npm installs update in place, npx users are told to rerun, Setup installs download the new Setup.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const PACKAGE_NAME = "polyphony-chat";
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];

export type InstallKind = "setup" | "global" | "npx" | "source";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  kind: InstallKind;
  checkedAt: string;
  registry?: string;
  error?: string;
  /** What "apply" will do for this install kind, for the settings page. */
  action: "npm-global" | "rerun-npx" | "download-setup" | "git-pull";
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Where this copy came from, judged by the path of the running code. */
export function detectInstallKind(appDir: string = defaultAppDir()): InstallKind {
  const p = appDir.replace(/\\/g, "/").toLowerCase();
  if (existsSync(path.join(appDir, "setup-install.json"))) return "setup";
  if (p.includes("/_npx/") || p.includes("/npm-cache/") || p.includes("/.npm/_npx")) return "npx";
  if (p.includes("/node_modules/" + PACKAGE_NAME) || p.includes("/node_modules/polyphony")) return "global";
  if (existsSync(path.join(appDir, "src")) && existsSync(path.join(appDir, "tsconfig.json"))) return "source";
  return "global";
}

export function defaultAppDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function fetchLatest(fetchImpl: typeof fetch = fetch): Promise<{ latest: string; registry: string }> {
  let lastErr = "";
  for (const reg of REGISTRIES) {
    try {
      const res = await fetchImpl(`${reg}/${PACKAGE_NAME}/latest`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const j = (await res.json()) as { version?: string };
      if (j.version) return { latest: j.version, registry: reg };
      lastErr = "no version field";
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(lastErr || "registry unreachable");
}

export class Updater {
  private last: UpdateInfo | null = null;
  constructor(private current: string, private appDir: string = defaultAppDir(), private fetchImpl: typeof fetch = fetch) {}

  get info(): UpdateInfo | null {
    return this.last;
  }

  async check(): Promise<UpdateInfo> {
    const kind = detectInstallKind(this.appDir);
    const action: UpdateInfo["action"] = kind === "global" ? "npm-global" : kind === "npx" ? "rerun-npx" : kind === "setup" ? "download-setup" : "git-pull";
    const base: UpdateInfo = { current: this.current, latest: null, hasUpdate: false, kind, checkedAt: new Date().toISOString(), action };
    try {
      const { latest, registry } = await fetchLatest(this.fetchImpl);
      this.last = { ...base, latest, registry, hasUpdate: compareSemver(latest, this.current) > 0 };
    } catch (e) {
      this.last = { ...base, error: (e as Error).message };
    }
    return this.last;
  }

  /** Runs `npm install -g polyphony-chat@latest` for global installs. Resolves with the log; the caller restarts. */
  applyGlobal(onLine?: (line: string) => void): Promise<{ ok: boolean; log: string }> {
    return new Promise((resolve) => {
      const registry = this.last?.registry ?? REGISTRIES[0];
      const cmd = `npm install -g ${PACKAGE_NAME}@latest --registry=${registry} --no-audit --no-fund`;
      const child = process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", cmd], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
        : spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      const on = (d: Buffer) => { const s = d.toString("utf8"); log += s; onLine?.(s); };
      child.stdout?.on("data", on);
      child.stderr?.on("data", on);
      child.on("error", (e) => resolve({ ok: false, log: log + e.message }));
      child.on("close", (code) => resolve({ ok: code === 0, log: log.slice(-4000) }));
    });
  }
}

/** Reads the version of the package at appDir (used by tests and the Setup marker). */
export function readPackageVersion(appDir: string): string {
  try { return (JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0"; } catch { return "0.0.0"; }
}
