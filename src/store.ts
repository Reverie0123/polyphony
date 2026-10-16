// JSON persistence. One file per collection, one file per session; every write goes through a temp file and rename.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  type Account, type Contact, type Session, type Settings, type LedgerEntry, type Message,
  DEFAULT_SETTINGS, DEFAULT_CONTEXT, DESKDOCK_CONTACT_ID,
} from "./models.js";

export const SCHEMA_VERSION = 1;

export function dataDir(): string {
  const env = process.env.POLYPHONY_HOME?.trim();
  if (env) return env;
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Roaming");
  return path.join(appData, "Polyphony");
}

export function newId(prefix = ""): string {
  return prefix + randomBytes(8).toString("hex");
}

export function now(): string {
  return new Date().toISOString();
}

/** Files that could not be parsed at startup (kept aside as *.corrupt-<time>); shown to the user on the first page load. */
export const corruptFiles: string[] = [];

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    // A corrupt file is kept aside for the user instead of being overwritten silently, and reported.
    try { renameSync(file, file + ".corrupt-" + Date.now()); } catch { /* ignore */ }
    corruptFiles.push(path.basename(file));
    console.error(`[polyphony] ${path.basename(file)} could not be parsed; moved aside as ${path.basename(file)}.corrupt-*`);
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8");
  // On Windows a scanner or editor holding the target makes rename fail with EPERM/EBUSY for a moment; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, file); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (attempt + 1));
    }
  }
}

interface Collection<T> { schemaVersion: number; items: T[] }

export class Store {
  readonly dir: string;
  /** ids of sessions deleted in this process: a late saveSession from a loop that still holds the object must not resurrect the file */
  private deleted = new Set<string>();
  private accounts: Account[];
  private contacts: Contact[];
  private keys: Record<string, string>;
  private settings: Settings;
  private sessionCache = new Map<string, Session>();

  constructor(dir: string = dataDir()) {
    this.dir = dir;
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    mkdirSync(path.join(dir, "attachments"), { recursive: true });
    mkdirSync(path.join(dir, "cache"), { recursive: true });
    mkdirSync(path.join(dir, "cli-cwd"), { recursive: true });
    this.accounts = readJson<Collection<Account>>(this.file("accounts.json"), { schemaVersion: SCHEMA_VERSION, items: [] }).items;
    this.contacts = readJson<Collection<Contact>>(this.file("contacts.json"), { schemaVersion: SCHEMA_VERSION, items: [] }).items;
    this.keys = readJson<{ schemaVersion: number; keys: Record<string, string> }>(this.file("keys.json"), { schemaVersion: SCHEMA_VERSION, keys: {} }).keys;
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(this.file("settings.json"), {}) };
    this.ensureDeskdockContact();
  }

  file(name: string): string {
    return path.join(this.dir, name);
  }

  // ---------- settings ----------

  getSettings(): Settings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const allowed = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
    const target = this.settings as unknown as Record<string, unknown>;
    const source = patch as unknown as Record<string, unknown>;
    const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    for (const k of allowed) {
      if (!(k in source) || k === "schemaVersion" || source[k] === undefined) continue;
      const v = source[k];
      const want = typeof defaults[k];
      // a value of the wrong type (e.g. concurrency: "3") would silently break what reads it; ignore it
      if (typeof v !== want) continue;
      if (want === "number" && !Number.isFinite(v as number)) continue;
      target[k] = v;
    }
    this.settings.schemaVersion = SCHEMA_VERSION;
    writeJsonAtomic(this.file("settings.json"), this.settings);
    return this.getSettings();
  }

  // ---------- accounts & keys ----------

  listAccounts(): Account[] {
    return this.accounts.map((a) => ({ ...a }));
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  getKey(accountId: string): string {
    return this.keys[accountId] ?? "";
  }

  /** Last four characters of the key, for display. */
  keyHint(accountId: string): string {
    const k = this.getKey(accountId);
    return k.length >= 4 ? k.slice(-4) : "";
  }

  addAccount(input: Omit<Account, "id" | "hasKey" | "createdAt"> & { key?: string }): Account {
    const { key, ...rest } = input;
    const account: Account = { ...rest, id: newId("acc_"), hasKey: !!key, createdAt: now() };
    this.accounts.push(account);
    if (key) this.keys[account.id] = key;
    this.saveAccounts();
    return { ...account };
  }

  updateAccount(id: string, patch: Partial<Omit<Account, "id" | "createdAt">> & { key?: string }): Account | undefined {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) return undefined;
    const { key, hasKey: _ignored, ...rest } = patch;
    Object.assign(a, rest);
    if (typeof key === "string") {
      if (key) this.keys[id] = key; else delete this.keys[id];
      a.hasKey = !!key;
    }
    this.saveAccounts();
    return { ...a };
  }

  deleteAccount(id: string): boolean {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    delete this.keys[id];
    this.contacts = this.contacts.filter((c) => c.accountId !== id);
    this.saveAccounts();
    this.saveContacts();
    return this.accounts.length < before;
  }

  private saveAccounts(): void {
    writeJsonAtomic(this.file("accounts.json"), { schemaVersion: SCHEMA_VERSION, items: this.accounts });
    writeJsonAtomic(this.file("keys.json"), { schemaVersion: SCHEMA_VERSION, keys: this.keys });
  }

  // ---------- contacts ----------

  listContacts(): Contact[] {
    return this.contacts.map((c) => ({ ...c }));
  }

  getContact(id: string): Contact | undefined {
    return this.contacts.find((c) => c.id === id);
  }

  addContact(input: Omit<Contact, "id" | "createdAt">): Contact {
    const c: Contact = { ...input, id: newId("c_"), createdAt: now() };
    this.contacts.push(c);
    this.saveContacts();
    return { ...c };
  }

  updateContact(id: string, patch: Partial<Omit<Contact, "id" | "createdAt">>): Contact | undefined {
    const c = this.contacts.find((x) => x.id === id);
    if (!c) return undefined;
    if (id === DESKDOCK_CONTACT_ID) {
      // Only cosmetic fields of the built-in member can change.
      const { nickname, avatar, persona } = patch;
      if (nickname !== undefined) c.nickname = nickname;
      if (avatar !== undefined) c.avatar = avatar;
      if (persona !== undefined) c.persona = persona;
    } else Object.assign(c, patch);
    this.saveContacts();
    return { ...c };
  }

  deleteContact(id: string): boolean {
    if (id === DESKDOCK_CONTACT_ID) return false;
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((c) => c.id !== id);
    this.saveContacts();
    return this.contacts.length < before;
  }

  private saveContacts(): void {
    writeJsonAtomic(this.file("contacts.json"), { schemaVersion: SCHEMA_VERSION, items: this.contacts });
  }

  private ensureDeskdockContact(): void {
    if (this.contacts.some((c) => c.id === DESKDOCK_CONTACT_ID)) return;
    this.contacts.unshift({
      id: DESKDOCK_CONTACT_ID,
      accountId: "",
      model: "",
      nickname: "DeskDock",
      avatar: "🖥",
      persona: "",
      supportsTools: true,
      supportsVision: false,
      enabled: true,
      createdAt: now(),
    });
    this.saveContacts();
  }

  // ---------- sessions ----------

  listSessions(): Omit<Session, "messages">[] {
    const out: Omit<Session, "messages">[] = [];
    for (const name of readdirSync(path.join(this.dir, "sessions"))) {
      if (!name.endsWith(".json")) continue;
      const s = this.getSession(name.slice(0, -5));
      if (!s) continue;
      const { messages, ...meta } = s;
      out.push({ ...meta, lastMessage: lastText(messages) } as Omit<Session, "messages"> & { lastMessage: string });
    }
    out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  getSession(id: string): Session | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || this.deleted.has(id)) return undefined;
    const cached = this.sessionCache.get(id);
    if (cached) return cached;
    const file = path.join(this.dir, "sessions", id + ".json");
    if (!existsSync(file)) return undefined;
    const s = readJson<Session | null>(file, null);
    if (!s) return undefined;
    this.sessionCache.set(id, s);
    return s;
  }

  createSession(input: Partial<Session> & { kind: Session["kind"]; title: string }): Session {
    const t = now();
    const s: Session = {
      schemaVersion: SCHEMA_VERSION,
      id: newId("s_"),
      kind: input.kind,
      title: input.title,
      intro: input.intro ?? "",
      members: input.members ?? [],
      createdAt: t,
      updatedAt: t,
      pinned: false,
      context: input.context ?? { ...DEFAULT_CONTEXT },
      budget: input.budget ?? {},
      spentTotal: 0,
      summary: null,
      discussion: null,
      allowModelMentions: input.allowModelMentions ?? false,
      speakingOrder: input.speakingOrder ?? "list",
      roundGapSec: input.roundGapSec ?? 5,
      canEndDiscussion: input.canEndDiscussion ?? [],
      templateId: input.templateId,
      nextSeq: 1,
      messages: [],
    };
    this.sessionCache.set(s.id, s);
    this.saveSession(s);
    return s;
  }

  get corruptFiles(): string[] { return [...corruptFiles]; }

  saveSession(s: Session): void {
    if (this.deleted.has(s.id)) return;
    s.updatedAt = now();
    writeJsonAtomic(path.join(this.dir, "sessions", s.id + ".json"), s);
  }

  deleteSession(id: string): boolean {
    const s = this.getSession(id);
    if (!s) return false;
    this.deleted.add(id); // after the read: getSession hides deleted ids, so the order matters
    this.sessionCache.delete(id);
    try { unlinkSync(path.join(this.dir, "sessions", id + ".json")); } catch { return false; }
    return true;
  }

  appendMessage(s: Session, m: Omit<Message, "id" | "seq" | "createdAt"> & Partial<Pick<Message, "id" | "createdAt">>): Message {
    const msg: Message = { ...m, id: m.id ?? newId("m_"), seq: s.nextSeq++, createdAt: m.createdAt ?? now() };
    s.messages.push(msg);
    this.saveSession(s);
    return msg;
  }

  // ---------- ledger ----------

  appendLedger(entry: LedgerEntry): void {
    appendFileSync(this.file("ledger.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  }

  readLedger(): LedgerEntry[] {
    const file = this.file("ledger.jsonl");
    if (!existsSync(file)) return [];
    const out: LedgerEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as LedgerEntry); } catch { /* skip bad line */ }
    }
    return out;
  }
}

function lastText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === "notice") continue;
    return m.text.slice(0, 80);
  }
  return "";
}
