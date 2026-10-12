// Rolling summary of the shared history that has scrolled out of the recent window. Runs in the background after a
// reply; while it runs, calls keep using the previous summary. See docs/设计方案.md section 6.
import type { Message, Session } from "./models.js";
import { estimateTokens } from "./models.js";
import type { Store } from "./store.js";
import type { Pricing } from "./pricing.js";
import { messageText, summaryCandidates } from "./context.js";
import { pickSecretary } from "./roles.js";
import type { Broadcast, CallContact } from "./engine.js";

export const SUMMARY_MIN_MESSAGES = 20;
export const SUMMARY_MIN_TOKENS = 4000;

export interface SummarizerDeps {
  store: Store;
  pricing: Pricing;
  broadcast: Broadcast;
  lang: () => "zh" | "en";
  call: CallContact;
  minMessages?: number;
  minTokens?: number;
}

export class Summarizer {
  private locks = new Map<string, Promise<void>>();
  constructor(private deps: SummarizerDeps) {}

  get busy(): number {
    return this.locks.size;
  }

  /** Decides whether a summary pass is due and runs it in the background. Returns the pass promise for tests. */
  maybeRun(session: Session): Promise<void> {
    const existing = this.locks.get(session.id);
    if (existing) return existing;
    const lang = this.deps.lang();
    const { pending } = summaryCandidates(session, lang);
    const tokens = pending.reduce((n, m) => n + estimateTokens(messageText(m, lang)), 0);
    const due = pending.length >= (this.deps.minMessages ?? SUMMARY_MIN_MESSAGES) || tokens >= (this.deps.minTokens ?? SUMMARY_MIN_TOKENS) || (!!session.summary?.dirty && pending.length > 0);
    if (!due) return Promise.resolve();
    const run = this.run(session, pending, lang).catch((err) => { console.error("summary failed:", (err as Error).message); }).finally(() => this.locks.delete(session.id));
    this.locks.set(session.id, run);
    return run;
  }

  private async run(session: Session, pending: Message[], lang: "zh" | "en"): Promise<void> {
    const { store, pricing, broadcast } = this.deps;
    const settings = store.getSettings();
    const secretary = pickSecretary(store, pricing, settings);
    if (!secretary) return;
    const contacts = store.listContacts();
    const nick = (id: string) => (id === "user" ? (lang === "zh" ? "用户" : "User") : contacts.find((c) => c.id === id)?.nickname ?? id);
    const old = session.summary && !session.summary.dirty ? session.summary.text : "";
    const body = pending.map((m) => `[${nick(m.sender)}]: ${messageText(m, lang).slice(0, 1500)}`).join("\n\n");
    const system = lang === "zh"
      ? "你是群聊记录员。把给你的聊天记录压缩成一段客观摘要，保留：讨论的问题、每个人的立场和关键论点、已达成的结论、未解决的分歧、提到的具体数字和名字。不超过 300 字，不加评论，不用列表。"
      : "You are the group chat secretary. Compress the transcript into one objective summary: the questions discussed, each participant's position and key arguments, conclusions reached, open disagreements, concrete numbers and names. Under 200 words, no commentary, no lists.";
    const prompt = (old ? (lang === "zh" ? `已有摘要：\n${old}\n\n` : `Existing summary:\n${old}\n\n`) : "") + (lang === "zh" ? `新增记录：\n${body}\n\n请输出更新后的完整摘要。` : `New messages:\n${body}\n\nWrite the updated complete summary.`);
    const r = await this.deps.call(secretary, { model: secretary.model, system, messages: [{ role: "user", content: prompt }], maxTokens: 800 }, { purpose: "summary", sessionId: session.id });
    const text = r.text.trim();
    if (!text) return;
    session.summary = { text, coversUpToSeq: pending[pending.length - 1].seq, generatedAt: new Date().toISOString(), dirty: false };
    const costStr = r.cost.kind === "free" ? "¥0" : r.cost.priced ? `¥${r.cost.cny.toFixed(3)}` : "";
    const notice = store.appendMessage(session, {
      sender: "system",
      kind: "notice",
      text: lang === "zh" ? `记录员（${secretary.nickname}）整理了前 ${pending.length} 条${costStr ? "，" + costStr : ""}` : `Secretary (${secretary.nickname}) summarised ${pending.length} earlier messages${costStr ? ", " + costStr : ""}`,
      attachments: [], mentions: [], excludedFromContext: true, starred: false, pinned: false, status: "done",
    });
    broadcast("message.created", { sessionId: session.id, message: notice });
    broadcast("session.updated", { session: { ...session, messages: undefined } });
  }
}
