// HTTP API + SSE + static files, with the token / Host / Origin checks from docs/设计方案.md section 2.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { Pricing } from "./pricing.js";
import { Engine } from "./engine.js";
import { Attachments, isImage } from "./attachments.js";
import { Vision } from "./vision.js";
import { Summarizer } from "./summary.js";
import { Orchestrator } from "./orchestrator.js";
import { parseMentionsIn } from "./mentions.js";
import { discoverModels } from "./providers/discover.js";
import { ProviderError } from "./providers/index.js";
import { type Account, type Attachment, type Contact, type Member, type Message, type Session, type Settings, DESKDOCK_CONTACT_ID } from "./models.js";

export interface ServerOptions {
  store: Store;
  pricing: Pricing;
  engine: Engine;
  attachments: Attachments;
  vision: Vision;
  summarizer: Summarizer;
  orchestrator: Orchestrator;
  token: string;
  lanToken?: string;
  version: string;
  webDir?: string;
  /** Called whenever the number of connected pages changes. */
  onClients?: (n: number) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "error") {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function defaultWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "web");
}

export class SseHub {
  private clients = new Set<http.ServerResponse>();
  private seq = 0;
  constructor(private onChange?: (n: number) => void) {}

  get size(): number {
    return this.clients.size;
  }

  add(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    this.onChange?.(this.clients.size);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 25000);
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
      this.onChange?.(this.clients.size);
    });
  }

  broadcast(event: string, data: unknown): void {
    const payload = `id: ${++this.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try { c.write(payload); } catch { this.clients.delete(c); }
    }
  }
}

function localAddresses(): Set<string> {
  const set = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === "IPv4") set.add(i.address);
  return set;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export { parseMentionsIn as parseMentions } from "./mentions.js";

export function createApp(opts: ServerOptions): { server: http.Server; hub: SseHub } {
  const { store, pricing, engine, attachments, vision, summarizer, orchestrator } = opts;
  const webDir = opts.webDir ?? defaultWebDir();
  const hub = new SseHub(opts.onClients);

  const tokenOk = (req: http.IncomingMessage, url: URL): boolean => {
    const given = (req.headers["x-polyphony-token"] as string | undefined) ?? url.searchParams.get("token") ?? "";
    if (!given) return false;
    if (safeEqual(given, opts.token)) return true;
    return !!opts.lanToken && safeEqual(given, opts.lanToken);
  };

  const hostOk = (req: http.IncomingMessage): boolean => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const allowed = store.getSettings().lanAccess ? localAddresses() : new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
    if (!allowed.has(host)) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        if (!allowed.has(o.hostname) && !allowed.has(`[${o.hostname}]`)) return false;
      } catch { return false; }
    }
    return true;
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c: Buffer) => { data += c.toString("utf8"); if (data.length > 20_000_000) { reject(new HttpError(413, "body too large")); req.destroy(); } });
      req.on("end", () => { try { resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {}); } catch { reject(new HttpError(400, "invalid JSON")); } });
      req.on("error", reject);
    });

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const maskAccount = (a: Account) => ({ ...a, keyHint: store.keyHint(a.id) });

  const getSession = (id: string): Session => {
    const s = store.getSession(id);
    if (!s) throw new HttpError(404, "session not found", "not_found");
    return s;
  };

  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
  const numOr = (v: unknown, fallback: number | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const p = url.pathname;
    const parts = p.split("/").filter(Boolean); // ["api", "sessions", id, ...]
    const seg = (i: number) => decodeURIComponent(parts[i] ?? "");

    if (p === "/health") return json(res, 200, { ok: true, app: "polyphony", version: opts.version });

    if (!p.startsWith("/api/")) return serveStatic(res, webDir, p);

    if (!tokenOk(req, url)) throw new HttpError(401, "missing or wrong token", "token");

    if (p === "/api/events" && method === "GET") return hub.add(res);

    if (p === "/api/bootstrap" && method === "GET") {
      return json(res, 200, {
        version: opts.version,
        settings: store.getSettings(),
        accounts: store.listAccounts().map(maskAccount),
        contacts: store.listContacts(),
        sessions: store.listSessions(),
        pricingFetchedAt: pricing.onlineFetchedAt,
        lanAddresses: store.getSettings().lanAccess ? [...localAddresses()].filter((a) => /^\d/.test(a) && a !== "127.0.0.1") : [],
        lanToken: store.getSettings().lanAccess ? opts.lanToken ?? null : null,
      });
    }

    // ----- attachments -----
    if (p === "/api/upload" && method === "POST") {
      const b = await readBody(req);
      const data = str(b.data);
      if (!data) throw new HttpError(400, "empty file", "empty");
      let bytes: Buffer;
      try { bytes = Buffer.from(data, "base64"); } catch { throw new HttpError(400, "bad base64"); }
      try {
        return json(res, 200, attachments.save(str(b.name) || "file", str(b.mime), bytes));
      } catch (e) {
        throw new HttpError(413, (e as Error).message, "too_large");
      }
    }
    if (parts[1] === "attachments" && parts.length === 3 && method === "GET") {
      const file = attachments.read(seg(2));
      if (!file) throw new HttpError(404, "attachment not found", "not_found");
      res.writeHead(200, { "Content-Type": attachments.mimeOf(seg(2)), "Cache-Control": "private, max-age=86400", "Content-Length": file.bytes.length });
      res.end(file.bytes);
      return;
    }

    // ----- search -----
    if (p === "/api/search" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      if (!q) return json(res, 200, { results: [] });
      const results: { sessionId: string; title: string; messageId: string; seq: number; sender: string; snippet: string; createdAt: string }[] = [];
      for (const meta of store.listSessions()) {
        const s = store.getSession(meta.id);
        if (!s) continue;
        for (const m of s.messages) {
          const hay = (m.text + " " + (m.attachments ?? []).map((a) => a.name).join(" ")).toLowerCase();
          const i = hay.indexOf(q);
          if (i < 0) continue;
          const start = Math.max(0, i - 30);
          results.push({ sessionId: s.id, title: s.title, messageId: m.id, seq: m.seq, sender: m.sender, snippet: m.text.slice(start, start + 90), createdAt: m.createdAt });
          if (results.length >= 100) break;
        }
        if (results.length >= 100) break;
      }
      results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json(res, 200, { results });
    }

    // ----- settings -----
    if (p === "/api/settings" && method === "PATCH") {
      const body = await readBody(req);
      return json(res, 200, store.updateSettings(body as Partial<Settings>));
    }

    // ----- accounts -----
    if (parts[1] === "accounts") {
      if (method === "GET" && parts.length === 2) return json(res, 200, store.listAccounts().map(maskAccount));
      if (method === "POST" && parts.length === 2) {
        const b = await readBody(req);
        const provider = str(b.provider);
        if (!["openai", "anthropic", "ollama", "cli"].includes(provider)) throw new HttpError(400, "bad provider");
        const a = store.addAccount({
          provider: provider as Account["provider"],
          name: str(b.name) || provider,
          baseURL: str(b.baseURL, defaultBaseURL(provider)),
          key: str(b.key) || undefined,
          cliKind: provider === "cli" ? (str(b.cliKind) === "codex" ? "codex" : "claude") : undefined,
          cliPath: str(b.cliPath) || undefined,
          enabled: true,
        });
        return json(res, 200, maskAccount(a));
      }
      const id = seg(2);
      if (method === "GET" && parts[3] === "models") {
        const a = store.getAccount(id);
        if (!a) throw new HttpError(404, "account not found", "not_found");
        try {
          return json(res, 200, await discoverModels(a, store.getKey(a.id)));
        } catch (e) {
          const pe = e instanceof ProviderError ? e : new ProviderError(String((e as Error).message), "unknown");
          return json(res, 502, { error: pe.message, code: pe.code });
        }
      }
      if (method === "PATCH" && parts.length === 3) {
        const b = await readBody(req);
        const patch: Record<string, unknown> = {};
        for (const k of ["name", "baseURL", "cliPath", "enabled", "cliKind"]) if (k in b) patch[k] = b[k];
        if (typeof b.key === "string") patch.key = b.key;
        const a = store.updateAccount(id, patch);
        if (!a) throw new HttpError(404, "account not found", "not_found");
        return json(res, 200, maskAccount(a));
      }
      if (method === "DELETE" && parts.length === 3) return json(res, 200, { ok: store.deleteAccount(id) });
    }

    // ----- contacts -----
    if (parts[1] === "contacts") {
      if (method === "GET" && parts.length === 2) return json(res, 200, store.listContacts());
      if (method === "POST" && parts.length === 2) {
        const b = await readBody(req);
        const account = store.getAccount(str(b.accountId));
        if (!account) throw new HttpError(400, "account not found", "not_found");
        const model = str(b.model);
        const c = store.addContact({
          accountId: account.id,
          model,
          nickname: str(b.nickname) || model || account.name,
          avatar: str(b.avatar) || (str(b.nickname) || model || "AI").slice(0, 1).toUpperCase(),
          persona: str(b.persona),
          supportsTools: bool(b.supportsTools, guessTools(account, model)),
          supportsVision: bool(b.supportsVision, guessVision(model)),
          temperature: numOr(b.temperature, undefined),
          maxTokens: numOr(b.maxTokens, undefined),
          enabled: true,
        });
        return json(res, 200, c);
      }
      const id = seg(2);
      if (method === "PATCH" && parts.length === 3) {
        const b = await readBody(req);
        const patch: Partial<Contact> = {};
        for (const k of ["model", "nickname", "avatar", "persona", "supportsTools", "supportsVision", "enabled", "accountId"] as const) {
          if (k in b) (patch as Record<string, unknown>)[k] = b[k];
        }
        if ("temperature" in b) patch.temperature = numOr(b.temperature, undefined);
        if ("maxTokens" in b) patch.maxTokens = numOr(b.maxTokens, undefined);
        const c = store.updateContact(id, patch);
        if (!c) throw new HttpError(404, "contact not found", "not_found");
        return json(res, 200, c);
      }
      if (method === "DELETE" && parts.length === 3) return json(res, 200, { ok: store.deleteContact(id) });
    }

    // ----- sessions -----
    if (parts[1] === "sessions") {
      if (method === "GET" && parts.length === 2) return json(res, 200, store.listSessions());
      if (method === "POST" && parts.length === 2) {
        const b = await readBody(req);
        const kind = str(b.kind) === "group" ? "group" : "direct";
        const rawMembers = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]) : [];
        const members: Member[] = rawMembers
          .filter((m) => store.getContact(str(m.contactId)))
          .map((m, i) => ({ contactId: str(m.contactId), roleCard: str(m.roleCard), muted: false, order: i, driverContactId: str(m.driverContactId) || undefined }));
        if (!members.length) throw new HttpError(400, "a session needs at least one member", "no_members");
        if (kind === "direct" && members.length !== 1) throw new HttpError(400, "a direct chat has exactly one member", "bad_members");
        const title = str(b.title) || (kind === "direct" ? store.getContact(members[0].contactId)!.nickname : members.map((m) => store.getContact(m.contactId)!.nickname).join("、"));
        const s = store.createSession({
          kind,
          title,
          intro: str(b.intro),
          members,
          budget: typeof b.budget === "object" && b.budget ? (b.budget as Session["budget"]) : {},
        });
        hub.broadcast("session.created", { session: withoutMessages(s) });
        return json(res, 200, s);
      }
      const id = seg(2);
      const s = getSession(id);
      if (method === "GET" && parts.length === 3) return json(res, 200, s);
      if (method === "PATCH" && parts.length === 3) {
        const b = await readBody(req);
        if (typeof b.title === "string") s.title = b.title;
        if (typeof b.intro === "string") s.intro = b.intro;
        if (typeof b.pinned === "boolean") s.pinned = b.pinned;
        if (typeof b.allowModelMentions === "boolean") s.allowModelMentions = b.allowModelMentions;
        if (typeof b.speakingOrder === "string" && ["list", "random", "host", "race"].includes(b.speakingOrder)) s.speakingOrder = b.speakingOrder as Session["speakingOrder"];
        if (typeof b.roundGapSec === "number") s.roundGapSec = Math.max(0, b.roundGapSec);
        if (Array.isArray(b.canEndDiscussion)) s.canEndDiscussion = (b.canEndDiscussion as unknown[]).filter((x): x is string => typeof x === "string" && s.members.some((m) => m.contactId === x));
        if (b.context && typeof b.context === "object") {
          const c = b.context as Record<string, unknown>;
          s.context = { recentCount: numOr(c.recentCount, s.context.recentCount)!, recentTokens: numOr(c.recentTokens, s.context.recentTokens)! };
        }
        if (b.budget && typeof b.budget === "object") s.budget = b.budget as Session["budget"];
        if (Array.isArray(b.members)) {
          const raw = b.members as Record<string, unknown>[];
          s.members = raw.filter((m) => store.getContact(str(m.contactId))).map((m, i) => ({
            contactId: str(m.contactId), roleCard: str(m.roleCard), muted: bool(m.muted), order: i, driverContactId: str(m.driverContactId) || undefined,
          }));
        }
        store.saveSession(s);
        hub.broadcast("session.updated", { session: withoutMessages(s) });
        return json(res, 200, s);
      }
      if (method === "DELETE" && parts.length === 3) {
        for (const m of s.messages) engine.cancel(m.id);
        const ok = store.deleteSession(id);
        hub.broadcast("session.deleted", { sessionId: id });
        return json(res, 200, { ok });
      }
      if (parts[3] === "export" && method === "GET") {
        const md = exportMarkdown(s, store.listContacts(), (m) => engine.textOf(m), store.getSettings());
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(s.title.replace(/[\\/:*?"<>|]/g, "_"))}.md` });
        res.end(md);
        return;
      }
      if (parts[3] === "messages" && method === "POST" && parts.length === 4) {
        const b = await readBody(req);
        const text = str(b.text).trim();
        const hashes = Array.isArray(b.attachments) ? (b.attachments as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const atts: Attachment[] = hashes.map((h) => attachments.get(h)).filter((a): a is Attachment => !!a);
        if (!text && !atts.length) throw new HttpError(400, "empty message", "empty");
        const nicks = s.members.map((m) => ({ contactId: m.contactId, nickname: store.getContact(m.contactId)?.nickname ?? "" }));
        let mentions = Array.isArray(b.mentions) ? (b.mentions as unknown[]).filter((x): x is string => typeof x === "string") : [];
        for (const id of parseMentionsIn(text, nicks)) if (!mentions.includes(id)) mentions.push(id);
        if (s.kind === "direct") mentions = [s.members[0].contactId];
        mentions = mentions.filter((m) => s.members.some((x) => x.contactId === m));
        const privateTo = bool(b.whisper) && mentions.length ? mentions : undefined;
        const editedFrom = str(b.editedFrom) || undefined;
        if (editedFrom) {
          const old = s.messages.find((x) => x.id === editedFrom && x.sender === "user");
          if (old) { old.excludedFromContext = true; hub.broadcast("message.updated", { sessionId: s.id, message: old }); }
        }
        const kind: Message["kind"] = atts.some((a) => isImage(a.mime)) ? "image" : atts.length ? "file" : "text";
        const userMsg = store.appendMessage(s, {
          sender: "user", kind, text, attachments: atts, mentions, replyTo: str(b.replyTo) || undefined, editedFrom,
          privateTo, excludedFromContext: false, starred: false, pinned: false, status: "done",
        });
        hub.broadcast("message.created", { sessionId: s.id, message: userMsg });
        // Replies run after the response is sent; the page follows them over SSE. Image captions come first so the
        // mentioned models see them.
        const run = async () => {
          await vision.describe(s, userMsg);
          for (const contactId of mentions) {
            if (contactId === DESKDOCK_CONTACT_ID) continue;
            await engine.reply(s, contactId, userMsg);
          }
          if (!mentions.length) void summarizer.maybeRun(s);
        };
        void run();
        return json(res, 200, { message: userMsg });
      }
      // ----- free discussion -----
      if (parts[3] === "discussion" && method === "POST" && parts.length === 4) {
        const b = await readBody(req);
        if (s.kind !== "group") throw new HttpError(400, "discussions need a group", "bad_request");
        const question = str(b.question).trim();
        if (!question) throw new HttpError(400, "empty question", "empty");
        try {
          const d = orchestrator.start(s, { question, rounds: numOr(b.rounds, 3)!, hostContactId: str(b.hostContactId) || undefined, summarizerContactId: str(b.summarizerContactId) || undefined });
          return json(res, 200, d);
        } catch (e) {
          throw new HttpError(409, (e as Error).message, "busy");
        }
      }
      if (parts[3] === "discussion" && method === "POST" && parts.length === 5) {
        const verb = parts[4];
        if (verb === "stop") orchestrator.stop(s, "user");
        else if (verb === "pause") orchestrator.pause(s);
        else if (verb === "resume") orchestrator.resume(s);
        else if (verb === "drop") orchestrator.drop(s);
        else throw new HttpError(404, "no such verb", "not_found");
        return json(res, 200, { discussion: s.discussion });
      }
      if (parts[3] === "mentions" && parts.length === 6 && method === "POST") {
        const ok = await orchestrator.decideMention(s, seg(4), parts[5] === "approve");
        return json(res, ok ? 200 : 404, { ok });
      }
      if (parts[3] === "messages" && parts[5] === "forward" && method === "POST") {
        const b = await readBody(req);
        const m = s.messages.find((x) => x.id === seg(4));
        const target = store.getSession(str(b.targetSessionId));
        if (!m || !target) throw new HttpError(404, "message or target not found", "not_found");
        const copy = store.appendMessage(target, {
          sender: m.sender, kind: m.kind, text: m.text, attachments: m.attachments, mentions: [], forwardedFrom: { sessionId: s.id, messageId: m.id },
          excludedFromContext: false, starred: false, pinned: false, status: "done", model: m.model,
        });
        hub.broadcast("message.created", { sessionId: target.id, message: copy });
        hub.broadcast("session.updated", { session: withoutMessages(target) });
        return json(res, 200, copy);
      }
      if (parts[3] === "messages" && parts.length === 5) {
        const mid = seg(4);
        const m = s.messages.find((x) => x.id === mid);
        if (!m) throw new HttpError(404, "message not found", "not_found");
        if (method === "DELETE") {
          engine.cancel(mid);
          s.messages = s.messages.filter((x) => x.id !== mid);
          const touchesSummary = !!s.summary && m.seq <= s.summary.coversUpToSeq;
          if (touchesSummary) s.summary!.dirty = true;
          store.saveSession(s);
          hub.broadcast("message.deleted", { sessionId: s.id, messageId: mid });
          if (touchesSummary) void summarizer.maybeRun(s);
          return json(res, 200, { ok: true });
        }
        if (method === "PATCH") {
          const b = await readBody(req);
          let touchesSummary = false;
          if (typeof b.excludedFromContext === "boolean" && b.excludedFromContext !== m.excludedFromContext) {
            m.excludedFromContext = b.excludedFromContext;
            touchesSummary = !!s.summary && m.seq <= s.summary.coversUpToSeq;
            if (touchesSummary) s.summary!.dirty = true;
          }
          if (typeof b.starred === "boolean") m.starred = b.starred;
          if (typeof b.pinned === "boolean") m.pinned = b.pinned;
          store.saveSession(s);
          hub.broadcast("message.updated", { sessionId: s.id, message: m });
          if (touchesSummary) void summarizer.maybeRun(s);
          return json(res, 200, m);
        }
      }
      if (parts[3] === "messages" && parts[5] === "cancel" && method === "POST") {
        return json(res, 200, { ok: engine.cancel(seg(4)) });
      }
      if (parts[3] === "messages" && parts[5] === "regenerate" && method === "POST") {
        const mid = seg(4);
        const m = s.messages.find((x) => x.id === mid);
        if (!m || m.sender === "user" || m.sender === "system") throw new HttpError(404, "message not found", "not_found");
        if (m.status === "streaming") throw new HttpError(409, "still streaming", "busy");
        m.versions = [...(m.versions ?? []), { text: m.text, usage: m.usage, cost: m.cost, createdAt: m.createdAt }];
        m.excludedFromContext = true;
        store.saveSession(s);
        hub.broadcast("message.updated", { sessionId: s.id, message: m });
        const trigger = m.replyTo ? s.messages.find((x) => x.id === m.replyTo) : undefined;
        void engine.reply(s, m.sender, trigger);
        return json(res, 200, { ok: true });
      }
      if (parts[3] === "preview" && method === "POST") {
        const b = await readBody(req);
        const mentions = s.kind === "direct" ? [s.members[0].contactId] : (Array.isArray(b.mentions) ? (b.mentions as string[]) : []);
        const settings = store.getSettings();
        const out = mentions.map((cid) => {
          const c = store.getContact(cid);
          const a = c ? store.getAccount(c.accountId) : undefined;
          return {
            contactId: cid,
            nickname: c?.nickname ?? cid,
            provider: a?.provider ?? (cid === DESKDOCK_CONTACT_ID ? "deskdock" : "unknown"),
            host: a ? hostOf(a) : "",
            local: a?.provider === "ollama",
            estimate: c ? engine.preview(s, cid, str(b.text), settings) : undefined,
          };
        });
        return json(res, 200, { targets: out });
      }
    }

    // ----- ledger -----
    if (p === "/api/ledger" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const entries = store.readLedger();
      const today = new Date();
      const isToday = (iso: string) => { const d = new Date(iso); return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate(); };
      const byProvider: Record<string, { usd: number; calls: number }> = {};
      let sessionUsd = 0;
      let todayUsd = 0;
      let allUsd = 0;
      for (const e of entries) {
        allUsd += e.cost.usd;
        if (e.sessionId === sessionId) sessionUsd += e.cost.usd;
        if (isToday(e.at)) todayUsd += e.cost.usd;
        const k = e.provider === "cli" ? "cli" : e.provider;
        byProvider[k] = byProvider[k] ?? { usd: 0, calls: 0 };
        byProvider[k].usd += e.cost.usd;
        byProvider[k].calls++;
      }
      return json(res, 200, { sessionUsd, todayUsd, allUsd, byProvider });
    }

    // ----- pricing -----
    if (p === "/api/pricing" && method === "GET") return json(res, 200, { table: pricing.table(), fetchedAt: pricing.onlineFetchedAt });
    if (parts[1] === "pricing" && parts.length === 3 && method === "PUT") {
      const b = await readBody(req);
      const price = b.price && typeof b.price === "object" ? (b.price as { input: number; output: number; cacheRead: number; cacheWrite: number }) : null;
      pricing.setOverride(seg(2), price);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/pricing/refresh" && method === "POST") {
      const models = store.listContacts().map((c) => c.model).filter(Boolean);
      return json(res, 200, { refreshed: await pricing.refreshOnline(models), fetchedAt: pricing.onlineFetchedAt });
    }

    throw new HttpError(404, "no such route", "not_found");
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hostOk(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden host");
      return;
    }
    route(req, res, url).catch((err) => {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      if (err instanceof HttpError) json(res, err.status, { error: err.message, code: err.code });
      else {
        console.error(err);
        json(res, 500, { error: (err as Error).message ?? "internal error", code: "internal" });
      }
    });
  });
  return { server, hub };
}

function serveStatic(res: http.ServerResponse, webDir: string, urlPath: string): void {
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(readFileSync(file));
}

function withoutMessages(s: Session): Omit<Session, "messages"> {
  const { messages, ...rest } = s;
  return rest;
}

export function exportMarkdown(s: Session, contacts: Contact[], textOf: (m: Message) => string, settings: Settings): string {
  const nick = (id: string) => (id === "user" ? "我" : id === "system" ? "系统" : contacts.find((c) => c.id === id)?.nickname ?? id);
  const cny = settings.currency === "cny";
  const money = (m: Message) => {
    if (!m.cost) return "";
    if (m.cost.kind === "subscription") return "订阅";
    if (m.cost.kind === "free") return "免费";
    if (!m.cost.priced) return "未定价";
    return cny ? `¥${m.cost.cny.toFixed(4)}` : `$${m.cost.usd.toFixed(4)}`;
  };
  const lines: string[] = [`# ${s.title}`, ""];
  if (s.intro) lines.push(`> ${s.intro}`, "");
  lines.push(`成员：${s.members.map((m) => nick(m.contactId)).join("、")}`, "");
  for (const m of s.messages) {
    const when = m.createdAt.replace("T", " ").slice(0, 19);
    const flags: string[] = [];
    if (m.privateTo?.length) flags.push("悄悄话");
    if (m.excludedFromContext) flags.push("已移出共享历史");
    if (m.editedFrom) flags.push("编辑重发");
    if (m.forwardedFrom) flags.push("转发");
    if (m.status === "error") flags.push(`出错：${m.error?.message ?? ""}`);
    if (m.status === "cancelled") flags.push("已取消");
    const meta = [when, money(m), m.usage ? `输入 ${m.usage.input + m.usage.cacheRead} / 输出 ${m.usage.output}` : "", ...flags].filter(Boolean).join(" · ");
    lines.push(`### ${nick(m.sender)}`, `<sub>${meta}</sub>`, "");
    lines.push(textOf(m) || "（空）", "");
    for (const v of m.versions ?? []) lines.push("<details><summary>上一版</summary>", "", v.text, "", "</details>", "");
  }
  return lines.join("\n");
}

export function defaultBaseURL(provider: string): string {
  switch (provider) {
    case "openai": return "https://api.deepseek.com/v1";
    case "anthropic": return "https://api.anthropic.com";
    case "ollama": return "http://127.0.0.1:11434";
    default: return "";
  }
}

function hostOf(a: Account): string {
  if (a.provider === "cli") return a.cliKind === "codex" ? "OpenAI (Codex CLI)" : "Anthropic (Claude Code)";
  try { return new URL(a.baseURL || defaultBaseURL(a.provider)).host; } catch { return a.baseURL; }
}

function guessTools(a: Account, model: string): boolean {
  if (a.provider === "cli") return false;
  if (a.provider === "ollama") return /llama3\.[1-9]|qwen|mistral|gpt-oss|deepseek|glm|kimi/i.test(model);
  return true;
}

function guessVision(model: string): boolean {
  return /claude|gpt-4o|gpt-4\.1|gpt-5|o3|o4|gemini|vision|vl|llava|qwen.*vl|pixtral/i.test(model);
}
