// Runs one model reply end to end: build context, stream from the provider, record usage, cost and ledger.
// Also owns the concurrency slots and the list of in-flight replies so they can be cancelled.
import {
  type Contact, type Message, type Session, type Usage, type Cost, type Settings,
  ZERO_USAGE, estimateTokens, DESKDOCK_CONTACT_ID,
} from "./models.js";
import { messageText } from "./context.js";
import { Store } from "./store.js";
import { Pricing, computeCost } from "./pricing.js";
import { buildContext, cleanReply } from "./context.js";
import { getChatFn, ProviderError, type ChatRequest } from "./providers/index.js";

export type Broadcast = (event: string, data: unknown) => void;

export interface CallResult { text: string; usage: Usage; cost: Cost; model: string }
export interface CallMeta { purpose: "summary" | "vision" | "host"; sessionId: string; messageId?: string }
/** A plain, non-streaming call to one contact, used by background helpers (secretary, vision). Records the ledger. */
export type CallContact = (contact: Contact, req: Omit<ChatRequest, "signal">, meta: CallMeta) => Promise<CallResult>;

export interface EngineDeps {
  store: Store;
  pricing: Pricing;
  broadcast: Broadcast;
  lang: () => "zh" | "en";
  /** Called after every finished reply (done, error or cancelled); the summariser hooks in here. */
  afterReply?: (session: Session, message: Message) => void;
}

export class Engine {
  private running = 0;
  private waiting: (() => void)[] = [];
  private active = new Map<string, AbortController>();
  private background = 0;

  constructor(private deps: EngineDeps) {}

  set afterReply(fn: EngineDeps["afterReply"]) {
    this.deps.afterReply = fn;
  }

  /** Number of in-flight replies and background calls; the auto-exit timer stays quiet while this is above zero. */
  get busy(): number {
    return this.active.size + this.background;
  }

  /** Non-streaming call for background helpers. Throws ProviderError on failure. */
  callContact: CallContact = async (contact, req, meta) => {
    const { store, pricing } = this.deps;
    const account = store.getAccount(contact.accountId);
    if (!account || !account.enabled) throw new ProviderError("account missing or disabled", "not_found");
    const chat = getChatFn(account);
    if (!chat) throw new ProviderError(`no provider for ${account.provider}`, "not_found");
    const settings = store.getSettings();
    this.background++;
    try {
      return await this.slot(async () => {
        let text = "";
        let usage: Usage | undefined;
        let model = contact.model;
        let usageMissing = false;
        for await (const ev of chat({ account, key: store.getKey(account.id), cliCwd: store.file("cli-cwd") }, { ...req, signal: AbortSignal.timeout(600000) })) {
          if (ev.type === "delta") text += ev.text;
          else if (ev.type === "usage") usage = ev.usage;
          else if (ev.type === "status" && ev.text === "usage-missing") usageMissing = true;
          else if (ev.type === "done" && ev.model) model = ev.model;
        }
        if (!usage || usageMissing) {
          usage = { ...ZERO_USAGE, input: estimateTokens(req.system + req.messages.map((m) => m.content).join("")), output: estimateTokens(text), estimated: true };
        }
        const cost = computeCost(account.provider, usage, pricing.lookup(account.provider, contact.model), settings.usdToCny);
        if (usage.input + usage.output > 0) {
          store.appendLedger({
            at: new Date().toISOString(), sessionId: meta.sessionId, messageId: meta.messageId ?? "", contactId: contact.id, accountId: account.id,
            provider: account.provider, model, usage, cost, purpose: meta.purpose,
          });
          const s = store.getSession(meta.sessionId);
          if (s) { s.spentTotal += cost.usd; store.saveSession(s); }
          this.deps.broadcast("ledger.updated", { sessionId: meta.sessionId });
        }
        return { text, usage, cost, model };
      });
    } finally {
      this.background--;
    }
  };

  cancel(messageId: string): boolean {
    const c = this.active.get(messageId);
    if (!c) return false;
    c.abort();
    return true;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    const settings = this.deps.store.getSettings();
    while (this.running >= Math.max(1, settings.concurrency)) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /**
   * Creates the reply message immediately (status streaming) and resolves when it is done, errored or cancelled.
   * The returned promise never rejects; failures are recorded on the message.
   */
  async reply(session: Session, contactId: string, trigger: Message | undefined, purpose: "reply" = "reply"): Promise<Message> {
    const { store, pricing, broadcast } = this.deps;
    const contact = store.getContact(contactId);
    const settings = store.getSettings();
    const msg = store.appendMessage(session, {
      sender: contactId,
      kind: "text",
      text: "",
      attachments: [],
      mentions: [],
      excludedFromContext: false,
      starred: false,
      pinned: false,
      status: "streaming",
      replyTo: trigger?.id,
      model: contact?.model,
    });
    broadcast("message.created", { sessionId: session.id, message: msg });

    const fail = (code: string, message: string) => {
      msg.status = "error";
      msg.error = { code, message };
      store.saveSession(session);
      broadcast("message.done", { sessionId: session.id, message: msg });
      try { this.deps.afterReply?.(session, msg); } catch (err) { console.error(err); }
      return msg;
    };

    if (!contact || !contact.enabled) return fail("no_contact", "contact missing or disabled");
    if (contact.id === DESKDOCK_CONTACT_ID) return fail("not_implemented", "DeskDock member arrives in a later phase");
    const account = store.getAccount(contact.accountId);
    if (!account || !account.enabled) return fail("no_account", "account missing or disabled");
    if (account.provider === "cli" && !settings.cliEnabled) return fail("cli_disabled", "local CLI contacts are disabled in settings");
    const chat = getChatFn(account);
    if (!chat) return fail("no_provider", `no provider for ${account.provider}`);
    if (account.provider !== "ollama" && account.provider !== "cli" && !account.hasKey) return fail("auth", "no API key saved for this account");

    const member = session.members.find((m) => m.contactId === contactId);
    const contacts = store.listContacts();
    const built = buildContext(session, contact, member, contacts, { lang: this.deps.lang(), trigger });
    msg.contextInfo = built.info;

    const controller = new AbortController();
    this.active.set(msg.id, controller);
    const started = Date.now();
    let usage: Usage | undefined;
    let usageMissing = false;
    let finish: string | undefined;
    let lastFlush = 0;
    let pending = "";
    const flush = (force = false) => {
      if (!pending) return;
      if (!force && Date.now() - lastFlush < 60) return;
      broadcast("message.delta", { sessionId: session.id, messageId: msg.id, text: pending });
      pending = "";
      lastFlush = Date.now();
    };

    const req: ChatRequest = {
      model: contact.model,
      system: built.system,
      messages: built.messages,
      temperature: contact.temperature,
      maxTokens: contact.maxTokens,
      signal: controller.signal,
      cacheSystem: true,
    };

    try {
      await this.slot(async () => {
        for await (const ev of chat({ account, key: store.getKey(account.id), cliCwd: store.file("cli-cwd") }, req)) {
          switch (ev.type) {
            case "delta":
              msg.text += ev.text;
              pending += ev.text;
              flush();
              break;
            case "reasoning":
              msg.reasoning = (msg.reasoning ?? "") + ev.text;
              break;
            case "usage":
              usage = ev.usage;
              break;
            case "status":
              if (ev.text === "usage-missing") usageMissing = true;
              else broadcast("message.status", { sessionId: session.id, messageId: msg.id, status: ev.text });
              break;
            case "done":
              finish = ev.finish;
              if (ev.model) msg.model = ev.model;
              break;
            case "tool_call":
              // Phase 1 contacts have no tools; a stray call is shown as text so nothing is silently lost.
              msg.text += `\n[tool call ignored: ${ev.name}]`;
              break;
          }
        }
      });
      flush(true);
      const cleaned = cleanReply(msg.text, contact.nickname, contacts.filter((c) => c.id !== contact.id).map((c) => c.nickname));
      msg.text = cleaned.text;
      if (cleaned.truncatedImpersonation) msg.error = { code: "impersonation_cut", message: "reply cut where the model started speaking as another member" };
      msg.status = "done";
    } catch (err) {
      flush(true);
      const e = err instanceof ProviderError ? err : new ProviderError((err as Error).message ?? String(err), "unknown");
      if (e.code === "cancelled" || controller.signal.aborted) {
        msg.status = "cancelled";
        msg.error = { code: "cancelled", message: "cancelled" };
      } else {
        msg.status = "error";
        msg.error = { code: e.code, message: e.message };
      }
    } finally {
      this.active.delete(msg.id);
    }

    // Usage: reported by the provider, or estimated from characters when it was not.
    if (!usage || usageMissing || msg.status === "cancelled") {
      const est: Usage = {
        ...ZERO_USAGE,
        input: usage?.input ?? built.info.tokensEstimate,
        output: usage?.output ?? estimateTokens(msg.text + (msg.reasoning ?? "")),
        estimated: true,
      };
      usage = usage && !usageMissing && msg.status !== "cancelled" ? usage : est;
    }
    msg.usage = usage;
    msg.latencyMs = Date.now() - started;
    const cost: Cost = computeCost(account.provider, usage, pricing.lookup(account.provider, contact.model), settings.usdToCny);
    msg.cost = cost;
    if (finish === "max_tokens" || finish === "length") msg.error = msg.error ?? { code: "max_tokens", message: "reply hit the output limit" };
    session.spentTotal += cost.usd;
    store.saveSession(session);
    if (usage.input + usage.output > 0) {
      store.appendLedger({
        at: new Date().toISOString(),
        sessionId: session.id,
        messageId: msg.id,
        contactId: contact.id,
        accountId: account.id,
        provider: account.provider,
        model: msg.model ?? contact.model,
        usage,
        cost,
        purpose,
      });
      broadcast("ledger.updated", { sessionId: session.id });
    }
    broadcast("message.done", { sessionId: session.id, message: msg });
    try { this.deps.afterReply?.(session, msg); } catch (err) { console.error(err); }
    return msg;
  }

  /** Token and cost estimate for the privacy line, computed the same way a real call would be. */
  preview(session: Session, contactId: string, draft: string, settings: Settings): { tokens: number; cost: Cost; historyCount: number; summaryUsed: boolean } | undefined {
    const { store, pricing } = this.deps;
    const contact = store.getContact(contactId);
    if (!contact) return undefined;
    const account = store.getAccount(contact.accountId);
    const member = session.members.find((m) => m.contactId === contactId);
    const probe: Session = { ...session, messages: [...session.messages, draftMessage(draft, session.nextSeq)] };
    const built = buildContext(probe, contact, member, store.listContacts(), { lang: this.deps.lang() });
    const provider = account?.provider ?? "openai";
    const cost = computeCost(provider, { ...ZERO_USAGE, input: built.info.tokensEstimate, output: 400, estimated: true }, pricing.lookup(provider, contact.model), settings.usdToCny);
    return { tokens: built.info.tokensEstimate, cost, historyCount: built.info.historyCount, summaryUsed: built.info.summaryUsed };
  }

  /** Text of a message as models see it (used by export). */
  textOf(m: Message): string {
    return messageText(m, this.deps.lang());
  }
}

function draftMessage(text: string, seq: number): Message {
  return {
    id: "draft", seq, sender: "user", kind: "text", text, attachments: [], mentions: [], excludedFromContext: false,
    starred: false, pinned: false, status: "done", createdAt: new Date().toISOString(),
  };
}
