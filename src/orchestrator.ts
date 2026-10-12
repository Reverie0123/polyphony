// Free discussion state machine and model-to-model mentions. See docs/设计方案.md section 7.
import { type Contact, type Discussion, type Message, type Session, DESKDOCK_CONTACT_ID } from "./models.js";
import { Store, newId } from "./store.js";
import type { Broadcast, Engine } from "./engine.js";
import { hasEndMarker, isNoObjection, similarity } from "./context.js";
import { parseMentionsIn } from "./mentions.js";

export interface StartOptions {
  question: string;
  rounds: number;
  hostContactId?: string;
  summarizerContactId?: string;
}

export interface OrchestratorDeps {
  store: Store;
  engine: Engine;
  broadcast: Broadcast;
  lang: () => "zh" | "en";
  /** Test hook: shortens the gap between rounds. */
  gapMs?: (session: Session) => number;
}

const T = {
  zh: {
    started: (q: string, n: number, who: string) => `开始自由讨论（${n} 轮）：${q}\n参与：${who}`,
    turn: (r: number, n: number) => `轮到你了（第 ${r}/${n} 轮）。`,
    round: (r: number, n: number) => `第 ${r}/${n} 轮`,
    ended: (reason: string, rounds: number, cny: string) => `讨论结束：${reason}。共 ${rounds} 轮，花费 ${cny}`,
    paused: (r: number) => `讨论已暂停（第 ${r} 轮）`,
    resumed: "讨论继续",
    interrupted: (r: number) => `上次讨论在第 ${r} 轮中断，可以在讨论面板里继续或放弃`,
    reasons: { rounds: "轮数到", noObjection: "全员无异议", repeat: "发言开始重复", budget: "超出预算", user: "你停止了", end: "成员宣布结束", noSpeakers: "没有可以发言的成员" },
    mentionAsk: (from: string, to: string) => `${from} 想让 ${to} 接话`,
    mentionAuto: (from: string, to: string) => `${from} @ 了 ${to}，${to} 补一句`,
    mentionTurn: (from: string) => `${from} 刚才 @ 了你，请简短回应。`,
    summarize: "讨论已结束。请只做总结，分三块各用要点列出：共识、最强分歧、待办。不要加别的。",
    hostAsk: (names: string[]) => `你是主持人。根据刚才的讨论，决定下一个该谁发言。候选：${names.join("、")}。只回复一个昵称，不要解释。`,
    me: "我",
  },
  en: {
    started: (q: string, n: number, who: string) => `Free discussion started (${n} rounds): ${q}\nParticipants: ${who}`,
    turn: (r: number, n: number) => `Your turn (round ${r}/${n}).`,
    round: (r: number, n: number) => `round ${r}/${n}`,
    ended: (reason: string, rounds: number, cny: string) => `Discussion ended: ${reason}. ${rounds} rounds, cost ${cny}`,
    paused: (r: number) => `Discussion paused (round ${r})`,
    resumed: "Discussion resumed",
    interrupted: (r: number) => `The previous discussion was interrupted in round ${r}; continue or drop it from the discussion panel`,
    reasons: { rounds: "all rounds done", noObjection: "nobody objected", repeat: "speakers started repeating themselves", budget: "budget exceeded", user: "you stopped it", end: "a member ended it", noSpeakers: "no member can speak" },
    mentionAsk: (from: string, to: string) => `${from} wants ${to} to respond`,
    mentionAuto: (from: string, to: string) => `${from} mentioned ${to}; ${to} adds a word`,
    mentionTurn: (from: string) => `${from} just mentioned you; respond briefly.`,
    summarize: "The discussion is over. Summarise only, in three bullet lists: consensus, strongest disagreement, action items. Nothing else.",
    hostAsk: (names: string[]) => `You are the host. Based on the discussion so far, pick who speaks next. Candidates: ${names.join(", ")}. Reply with one nickname only.`,
    me: "Me",
  },
};

export class Orchestrator {
  private loops = new Map<string, Promise<void>>();
  private wakeups = new Map<string, () => void>();
  private mentionBudget = new Map<string, Set<string>>(); // sessionId -> contacts already auto-mentioned this round

  constructor(private deps: OrchestratorDeps) {}

  get busy(): number {
    return this.loops.size;
  }

  private t() {
    return T[this.deps.lang()];
  }

  private nick(id: string): string {
    if (id === "user") return this.t().me;
    return this.deps.store.getContact(id)?.nickname ?? id;
  }

  private notice(session: Session, text: string, extra: Partial<Message> = {}): Message {
    const m = this.deps.store.appendMessage(session, {
      sender: "system", kind: "notice", text, attachments: [], mentions: [], excludedFromContext: true, starred: false, pinned: false, status: "done", ...extra,
    });
    this.deps.broadcast("message.created", { sessionId: session.id, message: m });
    return m;
  }

  private speakers(session: Session): string[] {
    return session.members
      .filter((m) => !m.muted && m.contactId !== DESKDOCK_CONTACT_ID && this.deps.store.getContact(m.contactId)?.enabled)
      .sort((a, b) => a.order - b.order)
      .map((m) => m.contactId);
  }

  private orderFor(session: Session, base: string[]): string[] {
    if (session.speakingOrder === "random") {
      const arr = [...base];
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr;
    }
    return base;
  }

  // ----- lifecycle -----

  start(session: Session, opts: StartOptions): Discussion {
    if (session.discussion && session.discussion.status === "running") throw new Error("a discussion is already running");
    const speakers = this.speakers(session);
    if (!speakers.length) throw new Error("no member can speak");
    const question = this.deps.store.appendMessage(session, {
      sender: "user", kind: "text", text: opts.question, attachments: [], mentions: [], excludedFromContext: false, starred: false, pinned: false, status: "done",
    });
    this.deps.broadcast("message.created", { sessionId: session.id, message: question });
    const d: Discussion = {
      id: newId("d_"), question: opts.question, questionMessageId: question.id, rounds: Math.max(1, Math.min(50, Math.floor(opts.rounds) || 3)),
      currentRound: 1, order: this.orderFor(session, speakers), cursor: 0, status: "running", spent: 0, roundSpent: 0,
      startedAt: new Date().toISOString(), hostContactId: opts.hostContactId, summarizerContactId: opts.summarizerContactId, noObjection: [],
    };
    session.discussion = d;
    this.deps.store.saveSession(session);
    this.notice(session, this.t().started(opts.question, d.rounds, speakers.map((id) => this.nick(id)).join(opts.question && this.deps.lang() === "zh" ? "、" : ", ")));
    this.deps.broadcast("session.updated", { session: meta(session) });
    this.runLoop(session);
    return d;
  }

  stop(session: Session, reason: keyof typeof T.zh.reasons = "user"): void {
    const d = session.discussion;
    if (!d || (d.status !== "running" && d.status !== "paused")) return;
    d.status = "stopped";
    d.stopReason = reason;
    this.deps.store.saveSession(session);
    this.wakeups.get(session.id)?.();
    if (!this.loops.has(session.id)) void this.finish(session);
  }

  pause(session: Session): void {
    const d = session.discussion;
    if (!d || d.status !== "running") return;
    d.status = "paused";
    this.deps.store.saveSession(session);
    this.notice(session, this.t().paused(d.currentRound));
    this.deps.broadcast("session.updated", { session: meta(session) });
  }

  resume(session: Session): void {
    const d = session.discussion;
    if (!d || d.status !== "paused") return;
    d.status = "running";
    this.deps.store.saveSession(session);
    this.notice(session, this.t().resumed);
    this.deps.broadcast("session.updated", { session: meta(session) });
    if (this.loops.has(session.id)) this.wakeups.get(session.id)?.();
    else this.runLoop(session);
  }

  /** Marks discussions left running by a previous process as paused so the user can continue or drop them. */
  recover(session: Session): void {
    const d = session.discussion;
    if (d && d.status === "running") {
      d.status = "paused";
      this.deps.store.saveSession(session);
      this.notice(session, this.t().interrupted(d.currentRound));
    }
  }

  drop(session: Session): void {
    if (!session.discussion) return;
    session.discussion = null;
    this.deps.store.saveSession(session);
    this.deps.broadcast("session.updated", { session: meta(session) });
  }

  // ----- the loop -----

  private runLoop(session: Session): void {
    if (this.loops.has(session.id)) return;
    const p = this.loop(session).catch((err) => console.error("discussion loop failed:", (err as Error).message)).finally(() => { this.loops.delete(session.id); this.wakeups.delete(session.id); });
    this.loops.set(session.id, p);
  }

  private sleep(session: Session, ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeups.delete(session.id); resolve(); }, ms);
      this.wakeups.set(session.id, () => { clearTimeout(timer); resolve(); });
    });
  }

  private waitWhilePaused(session: Session): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const d = session.discussion;
        if (!d || d.status !== "paused") { this.wakeups.delete(session.id); resolve(); return; }
        this.wakeups.set(session.id, check);
      };
      check();
    });
  }

  private async loop(session: Session): Promise<void> {
    const { store, engine } = this.deps;
    const t = this.t();
    while (true) {
      const d = session.discussion;
      if (!d) return;
      if (d.status === "paused") { await this.waitWhilePaused(session); continue; }
      if (d.status !== "running") break;
      if (d.currentRound > d.rounds) { d.status = "stopped"; d.stopReason = "rounds"; break; }
      if (d.cursor === 0) {
        d.noObjection = [];
        d.roundSpent = 0;
        d.order = this.orderFor(session, this.speakers(session));
        this.mentionBudget.set(session.id, new Set());
        if (!d.order.length) { d.status = "stopped"; d.stopReason = "noSpeakers"; break; }
        this.deps.broadcast("discussion.round", { sessionId: session.id, round: d.currentRound, rounds: d.rounds });
      }
      const question = session.messages.find((m) => m.id === d.questionMessageId);
      const replyOpts = (round: number) => ({
        round,
        instruction: t.turn(round, d.rounds),
        discussion: { question: d.question, round, rounds: d.rounds, canEnd: false },
      });
      const turn = async (contactId: string): Promise<Message> => {
        const canEnd = session.canEndDiscussion.includes(contactId);
        const o = replyOpts(d.currentRound);
        o.discussion.canEnd = canEnd;
        const m = await engine.reply(session, contactId, question, o);
        if (m.cost) { d.spent += m.cost.usd; d.roundSpent += m.cost.usd; }
        return m;
      };

      let stop: keyof typeof T.zh.reasons | null = null;
      if (session.speakingOrder === "race") {
        // Everyone in the round starts at once; nobody sees this round's other replies.
        const results = await Promise.all(d.order.map((id) => turn(id)));
        d.cursor = d.order.length;
        for (const m of results) stop = stop ?? this.checkTurn(session, m);
      } else if (session.speakingOrder === "host" && d.hostContactId) {
        // The host picks the next speaker among those who have not spoken this round.
        while (d.cursor < d.order.length && d.status === "running") {
          const spoken = new Set(d.order.slice(0, d.cursor));
          const remaining = d.order.filter((id) => !spoken.has(id));
          const pick = await this.askHost(session, d.hostContactId, remaining);
          // Move the pick to the cursor position so the order array records what happened.
          const i = d.order.indexOf(pick, d.cursor);
          if (i > d.cursor) [d.order[d.cursor], d.order[i]] = [d.order[i], d.order[d.cursor]];
          const m = await turn(d.order[d.cursor]);
          d.cursor++;
          store.saveSession(session);
          stop = this.checkTurn(session, m);
          if (stop) break;
          if (d.status !== "running") break;
        }
      } else {
        while (d.cursor < d.order.length && d.status === "running") {
          const m = await turn(d.order[d.cursor]);
          d.cursor++;
          store.saveSession(session);
          stop = this.checkTurn(session, m);
          if (stop) break;
        }
      }
      if (stop) { d.status = "stopped"; d.stopReason = stop; break; }
      if (d.status !== "running") continue;
      if (d.cursor >= d.order.length) {
        // Round complete: budget and consensus checks, then the gap.
        if (d.noObjection.length === d.order.length) { d.status = "stopped"; d.stopReason = "noObjection"; break; }
        if (session.budget.perRound && d.roundSpent > session.budget.perRound) { d.status = "stopped"; d.stopReason = "budget"; break; }
        if (session.budget.total && session.spentTotal > session.budget.total) { d.status = "stopped"; d.stopReason = "budget"; break; }
        d.currentRound++;
        d.cursor = 0;
        store.saveSession(session);
        if (d.currentRound > d.rounds) { d.status = "stopped"; d.stopReason = "rounds"; break; }
        const gap = this.deps.gapMs ? this.deps.gapMs(session) : session.roundGapSec * 1000;
        await this.sleep(session, gap);
      }
    }
    store.saveSession(session);
    await this.finish(session);
  }

  /** Per-turn stop conditions: end marker, repetition, per-round budget. Also records no-objection replies. */
  private checkTurn(session: Session, m: Message): keyof typeof T.zh.reasons | null {
    const d = session.discussion!;
    if (m.status !== "done") return null;
    if (isNoObjection(m.text)) { if (!d.noObjection.includes(m.sender)) d.noObjection.push(m.sender); }
    if (hasEndMarker(m.text) && session.canEndDiscussion.includes(m.sender)) return "end";
    const previous = [...session.messages].reverse().find((x) => x.sender === m.sender && x.id !== m.id && x.round !== undefined && x.status === "done");
    if (previous && m.text.length >= 20 && similarity(previous.text, m.text) > 0.8) return "repeat";
    if (session.budget.perRound && d.roundSpent > session.budget.perRound) return "budget";
    return null;
  }

  private async askHost(session: Session, hostId: string, candidates: string[]): Promise<string> {
    if (candidates.length <= 1) return candidates[0];
    const host = this.deps.store.getContact(hostId);
    if (!host) return candidates[0];
    const names = candidates.map((id) => this.nick(id));
    try {
      const r = await this.deps.engine.callContact(host, {
        model: host.model, system: "", maxTokens: 50,
        messages: [{ role: "user", content: `${this.t().hostAsk(names)}\n\n${session.messages.slice(-8).map((m) => `[${this.nick(m.sender)}]: ${m.text.slice(0, 300)}`).join("\n")}` }],
      }, { purpose: "host", sessionId: session.id });
      const answer = r.text.trim();
      const hit = candidates.find((id) => answer.includes(this.nick(id)));
      return hit ?? candidates[0];
    } catch {
      return candidates[0];
    }
  }

  private async finish(session: Session): Promise<void> {
    const d = session.discussion;
    if (!d || d.status === "done" || d.status === "running" || d.status === "paused") return;
    const t = this.t();
    if (d.summarizerContactId && d.stopReason !== "user") {
      const question = session.messages.find((m) => m.id === d.questionMessageId);
      const m = await this.deps.engine.reply(session, d.summarizerContactId, question, { instruction: t.summarize, discussion: { question: d.question, round: d.currentRound, rounds: d.rounds, canEnd: false } });
      if (m.cost) d.spent += m.cost.usd;
    }
    d.status = "done";
    d.endedAt = new Date().toISOString();
    const settings = this.deps.store.getSettings();
    const cny = `¥${(d.spent * settings.usdToCny).toFixed(3)}`;
    const roundsDone = Math.min(d.rounds, d.cursor === 0 ? d.currentRound - 1 : d.currentRound);
    this.deps.store.saveSession(session);
    this.notice(session, t.ended(t.reasons[(d.stopReason ?? "rounds") as keyof typeof T.zh.reasons] ?? d.stopReason ?? "", Math.max(0, roundsDone), cny));
    this.deps.broadcast("session.updated", { session: meta(session) });
  }

  // ----- model-to-model mentions -----

  /** Called after every model reply: a reply that mentions another member either triggers it or asks the user. */
  async onReply(session: Session, m: Message): Promise<void> {
    if (session.kind !== "group" || m.sender === "user" || m.sender === "system" || m.status !== "done") return;
    const members = session.members.map((x) => ({ contactId: x.contactId, nickname: this.nick(x.contactId) }));
    const targets = parseMentionsIn(m.text, members).filter((id) => id !== m.sender && id !== DESKDOCK_CONTACT_ID);
    if (!targets.length) return;
    const budget = this.mentionBudget.get(session.id) ?? new Set<string>();
    this.mentionBudget.set(session.id, budget);
    for (const to of targets) {
      if (budget.has(to)) continue;
      budget.add(to);
      if (session.allowModelMentions) {
        this.notice(session, this.t().mentionAuto(this.nick(m.sender), this.nick(to)));
        await this.deps.engine.reply(session, to, m, { instruction: this.t().mentionTurn(this.nick(m.sender)) });
      } else {
        this.notice(session, this.t().mentionAsk(this.nick(m.sender), this.nick(to)), {
          action: { type: "mention", id: newId("mn_"), from: m.sender, to, sourceMessageId: m.id, status: "pending" },
        });
      }
    }
    if (!session.discussion || session.discussion.status !== "running") this.mentionBudget.delete(session.id);
  }

  /** Resolves a pending mention card. */
  async decideMention(session: Session, actionId: string, approve: boolean): Promise<boolean> {
    const card = session.messages.find((x) => x.action?.id === actionId);
    if (!card || !card.action || card.action.status !== "pending") return false;
    card.action.status = approve ? "approved" : "rejected";
    this.deps.store.saveSession(session);
    this.deps.broadcast("message.updated", { sessionId: session.id, message: card });
    if (approve) {
      const source = session.messages.find((x) => x.id === card.action!.sourceMessageId);
      await this.deps.engine.reply(session, card.action.to, source, { instruction: this.t().mentionTurn(this.nick(card.action.from)) });
    }
    return true;
  }
}

function meta(s: Session): Omit<Session, "messages"> {
  const { messages, ...rest } = s;
  return rest;
}

export type { Contact };
