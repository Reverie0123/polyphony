// Data model. Everything the store persists and the API exposes. See docs/设计方案.md section 4.

export type Provider = "openai" | "anthropic" | "ollama" | "cli";
export type CliKind = "claude" | "codex";

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  /** API base URL for openai / anthropic / ollama; unused for cli. */
  baseURL: string;
  /** Key lives in keys.json under this id; never serialized here. */
  hasKey: boolean;
  cliKind?: CliKind;
  /** Explicit executable path for cli accounts; empty means look up on PATH. */
  cliPath?: string;
  enabled: boolean;
  createdAt: string;
}

export interface Contact {
  id: string;
  accountId: string;
  /** Model id as the provider names it, e.g. deepseek-chat. Empty for the deskdock pseudo contact. */
  model: string;
  nickname: string;
  /** Short text avatar (1-2 chars) or a data URL. */
  avatar: string;
  /** Default persona card, used when a session member has no role card. */
  persona: string;
  supportsTools: boolean;
  supportsVision: boolean;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
  createdAt: string;
}

/** The built-in DeskDock member uses this fixed contact id so no code path special-cases it. */
export const DESKDOCK_CONTACT_ID = "deskdock";

export type SessionKind = "direct" | "group";
export type SpeakingOrder = "list" | "random" | "host" | "race";

export interface Member {
  contactId: string;
  /** Session-specific role card; overrides the contact persona when set. */
  roleCard: string;
  muted: boolean;
  order: number;
  /** DeskDock member only: the contact that drives its tool loop. */
  driverContactId?: string;
}

export interface ContextConfig {
  recentCount: number;
  recentTokens: number;
}

export interface Budget {
  perRound?: number;
  total?: number;
}

export interface Summary {
  text: string;
  coversUpToSeq: number;
  generatedAt: string;
  dirty: boolean;
}

export interface Discussion {
  id: string;
  question: string;
  /** Message id of the question post, used as the reply target of every turn. */
  questionMessageId: string;
  rounds: number;
  currentRound: number;
  /** Speaker order for the current round (contact ids). */
  order: string[];
  /** Index into `order` of the next speaker. */
  cursor: number;
  status: "running" | "paused" | "stopped" | "done";
  stopReason?: string;
  /** USD spent by this discussion so far, and in the current round. */
  spent: number;
  roundSpent: number;
  startedAt: string;
  endedAt?: string;
  hostContactId?: string;
  summarizerContactId?: string;
  /** Speakers who answered "[no objection]" in the current round. */
  noObjection: string[];
}

/** A card inside a notice message that waits for the user, e.g. "甲 wants 乙 to speak". */
export interface MessageAction {
  type: "mention";
  id: string;
  from: string;
  to: string;
  sourceMessageId: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface Session {
  schemaVersion: number;
  id: string;
  kind: SessionKind;
  title: string;
  intro: string;
  members: Member[];
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  context: ContextConfig;
  budget: Budget;
  spentTotal: number;
  summary: Summary | null;
  discussion: Discussion | null;
  allowModelMentions: boolean;
  speakingOrder: SpeakingOrder;
  roundGapSec: number;
  canEndDiscussion: string[];
  /** Role-card template the group was built from, if any (the discussion dialog enforces its minimum rounds). */
  templateId?: string;
  nextSeq: number;
  messages: Message[];
}

export type MessageKind = "text" | "image" | "file" | "steps" | "notice";
export type MessageStatus = "streaming" | "done" | "error" | "cancelled";

export interface Attachment {
  hash: string;
  name: string;
  mime: string;
  size: number;
  /** Text form: file contents for text files, description or OCR output for images. */
  caption?: string;
  /** Who produced the caption: a contact nickname or "ocr". */
  captionBy?: string;
  captionCost?: Cost;
  captionError?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** True when any field was estimated from characters instead of reported by the provider. */
  estimated: boolean;
}

export interface Cost {
  usd: number;
  cny: number;
  /** False when the model has no price entry; only tokens are shown then. */
  priced: boolean;
  /** "subscription" for cli contacts, "free" for ollama. */
  kind: "metered" | "subscription" | "free";
}

export interface MessageVersion {
  text: string;
  usage?: Usage;
  cost?: Cost;
  createdAt: string;
}

export interface Step {
  id: string;
  tool: string;
  argsSummary: string;
  resultSummary: string;
  ok: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface Message {
  id: string;
  seq: number;
  sender: "user" | "system" | string;
  kind: MessageKind;
  text: string;
  reasoning?: string;
  attachments: Attachment[];
  replyTo?: string;
  mentions: string[];
  privateTo?: string[];
  excludedFromContext: boolean;
  versions?: MessageVersion[];
  /** set when the message was regenerated in place */
  regeneratedAt?: string;
  editedFrom?: string;
  forwardedFrom?: { sessionId: string; messageId: string };
  starred: boolean;
  pinned: boolean;
  round?: number;
  action?: MessageAction;
  steps?: Step[];
  model?: string;
  latencyMs?: number;
  usage?: Usage;
  cost?: Cost;
  /** How many history messages and whether a summary were sent for this reply. */
  contextInfo?: { historyCount: number; summaryUsed: boolean; tokensEstimate: number };
  status: MessageStatus;
  error?: { code: string; message: string };
  createdAt: string;
}

export interface LedgerEntry {
  at: string;
  sessionId: string;
  messageId: string;
  contactId: string;
  accountId: string;
  provider: Provider;
  model: string;
  usage: Usage;
  cost: Cost;
  purpose: "reply" | "summary" | "vision" | "host";
}

export interface Settings {
  schemaVersion: number;
  lang: "auto" | "zh" | "en";
  theme: "auto" | "light" | "dark";
  port: number;
  lanAccess: boolean;
  currency: "cny" | "usd";
  usdToCny: number;
  costWarn: number;
  costAlert: number;
  secretaryContactId: "auto" | string;
  visionContactId: "auto" | "ocr" | string;
  autoExitMinutes: number;
  checkUpdates: boolean;
  cliEnabled: boolean;
  concurrency: number;
  /** Path to the deskdock executable or its dist/index.js; empty means look on PATH. */
  deskdockCommand: string;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  lang: "auto",
  theme: "auto",
  port: 7331,
  lanAccess: false,
  currency: "cny",
  usdToCny: 7.2,
  costWarn: 0.5,
  costAlert: 2,
  secretaryContactId: "auto",
  visionContactId: "auto",
  autoExitMinutes: 10,
  checkUpdates: true,
  cliEnabled: false,
  concurrency: 4,
  deskdockCommand: "",
};

export const DEFAULT_CONTEXT: ContextConfig = { recentCount: 12, recentTokens: 6000 };

export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    estimated: a.estimated || b.estimated,
  };
}

/** Rough token count: CJK characters are about one token each, other text about four characters per token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
