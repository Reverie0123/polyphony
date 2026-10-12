// Message list, composer, privacy line. Talks to app state through the `ctx` object passed in.
import { t, lang } from "./i18n.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import { post, del, patch } from "./api.js";

export function formatCost(cost, settings, opts = {}) {
  if (!cost) return "";
  if (cost.kind === "subscription") return t("privacy.subscription");
  if (cost.kind === "free") return t("cost.free");
  if (!cost.priced) return t("cost.unpriced");
  const cny = settings.currency === "cny";
  const v = cny ? cost.cny : cost.usd;
  const sym = cny ? "¥" : "$";
  const digits = v === 0 || v >= 1 ? 2 : v >= 0.01 ? 3 : 4;
  return `${sym}${v.toFixed(digits)}`;
}

export function costClass(cost, settings) {
  if (!cost || !cost.priced || cost.kind !== "metered") return "";
  if (cost.cny >= settings.costAlert) return "alert";
  if (cost.cny >= settings.costWarn) return "warn";
  return "";
}

function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

export function avatarEl(contact, extra = "") {
  const el = document.createElement("div");
  el.className = `avatar ${extra}`;
  if (!contact) { el.classList.add("user"); el.textContent = t("you").slice(0, 1); return el; }
  if (contact.id === "deskdock") el.classList.add("deskdock");
  const a = contact.avatar || contact.nickname?.slice(0, 1) || "?";
  if (a.startsWith("data:")) { const img = document.createElement("img"); img.src = a; el.appendChild(img); }
  else el.textContent = a.slice(0, 2);
  return el;
}

export class ChatView {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = document.getElementById("chat");
    this.listEl = document.getElementById("messages");
    this.input = document.getElementById("input");
    this.sendBtn = document.getElementById("btn-send");
    this.privacyEl = document.getElementById("privacy-line");
    this.mentionRow = document.getElementById("mention-row");
    this.replyBar = document.getElementById("reply-bar");
    this.whisperLabel = document.getElementById("whisper-label");
    this.whisper = document.getElementById("whisper");
    this.session = null;
    this.mentions = new Set();
    this.replyTo = null;
    this.previewTimer = null;
    this.nodes = new Map();

    this.sendBtn.addEventListener("click", () => this.send());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    });
    this.input.addEventListener("input", () => { this.autosize(); this.schedulePreview(); });
    this.whisper.addEventListener("change", () => this.schedulePreview());
  }

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(200, this.input.scrollHeight) + "px";
  }

  open(session) {
    this.session = session;
    this.mentions = new Set();
    this.replyTo = null;
    this.nodes.clear();
    this.listEl.innerHTML = "";
    this.replyBar.classList.add("hidden");
    const group = session.kind === "group";
    this.whisperLabel.classList.toggle("hidden", !group);
    this.renderMentionRow();
    for (const m of session.messages) this.renderMessage(m, false);
    this.scrollToEnd(true);
    this.updatePrivacy();
    this.input.focus();
  }

  contact(id) {
    return this.ctx.contacts.find((c) => c.id === id);
  }

  nick(id) {
    if (id === "user") return t("you");
    return this.contact(id)?.nickname ?? id;
  }

  renderMentionRow() {
    const s = this.session;
    this.mentionRow.innerHTML = "";
    if (!s || s.kind !== "group") { this.mentionRow.classList.add("hidden"); return; }
    this.mentionRow.classList.remove("hidden");
    for (const m of s.members) {
      const c = this.contact(m.contactId);
      const chip = document.createElement("span");
      chip.className = "mention-chip" + (this.mentions.has(m.contactId) ? " on" : "");
      chip.textContent = "@" + (c?.nickname ?? m.contactId);
      chip.addEventListener("click", () => {
        if (this.mentions.has(m.contactId)) this.mentions.delete(m.contactId); else this.mentions.add(m.contactId);
        this.renderMentionRow();
        this.schedulePreview();
      });
      this.mentionRow.appendChild(chip);
    }
  }

  schedulePreview() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.updatePrivacy(), 250);
  }

  async updatePrivacy() {
    const s = this.session;
    if (!s) return;
    const targets = s.kind === "direct" ? [s.members[0].contactId] : [...this.mentions];
    if (!targets.length) {
      this.privacyEl.innerHTML = `<span class="muted">${escapeHtml(t("privacy.none"))}</span>`;
      return;
    }
    let data;
    try {
      data = await post(`/api/sessions/${s.id}/preview`, { text: this.input.value, mentions: targets });
    } catch { return; }
    const settings = this.ctx.settings;
    const parts = [`<span>${escapeHtml(t("privacy.sendTo"))}</span>`];
    for (const tg of data.targets) {
      const local = tg.local;
      let label = tg.nickname;
      if (tg.host) label += `（${tg.host}）`;
      if (local) label += ` · ${t("privacy.local")}`;
      const est = tg.estimate ? ` · ${t("privacy.estimate", { tokens: fmtTokens(tg.estimate.tokens), cost: formatCost(tg.estimate.cost, settings) })}` : "";
      const title = tg.estimate ? t("privacy.context", { n: tg.estimate.historyCount, summary: tg.estimate.summaryUsed ? t("privacy.summary") : "" }) : "";
      parts.push(`<span class="chip ${local ? "local" : ""}" title="${escapeHtml(title)}">${escapeHtml(label)}${escapeHtml(est)}</span>`);
    }
    if (s.kind === "group") parts.push(`<span class="muted">· ${escapeHtml(this.whisper.checked ? t("privacy.whisper") : t("privacy.history"))}</span>`);
    this.privacyEl.innerHTML = parts.join(" ");
  }

  setReply(message) {
    this.replyTo = message;
    if (!message) { this.replyBar.classList.add("hidden"); return; }
    this.replyBar.classList.remove("hidden");
    this.replyBar.innerHTML = `<span>↩ ${escapeHtml(this.nick(message.sender))}: ${escapeHtml(message.text.slice(0, 80))}</span><button class="icon-btn" style="width:20px;height:20px">✕</button>`;
    this.replyBar.querySelector("button").addEventListener("click", () => this.setReply(null));
    this.input.focus();
  }

  async send() {
    const s = this.session;
    const text = this.input.value.trim();
    if (!s || !text) return;
    const body = { text, mentions: [...this.mentions], replyTo: this.replyTo?.id, whisper: this.whisper.checked };
    this.input.value = "";
    this.autosize();
    this.setReply(null);
    try {
      await post(`/api/sessions/${s.id}/messages`, body);
    } catch (err) {
      this.ctx.toast(err.message, true);
      this.input.value = text;
    }
    this.updatePrivacy();
  }

  // ----- events from the server -----

  onCreated(sessionId, message) {
    if (this.session?.id !== sessionId) return;
    this.session.messages.push(message);
    this.renderMessage(message, true);
  }

  onDelta(sessionId, messageId, text) {
    if (this.session?.id !== sessionId) return;
    const m = this.session.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.text += text;
    const node = this.nodes.get(messageId);
    if (node) {
      const atEnd = this.isAtEnd();
      node.querySelector(".content").innerHTML = renderMarkdown(m.text);
      node.querySelector(".typing")?.remove();
      if (atEnd) this.scrollToEnd();
    }
  }

  onStatus(sessionId, messageId, status) {
    if (this.session?.id !== sessionId) return;
    const node = this.nodes.get(messageId);
    if (node && status === "typing" && !node.querySelector(".typing")) {
      const el = document.createElement("div");
      el.className = "typing";
      el.textContent = t("msg.typing");
      node.querySelector(".bubble").appendChild(el);
    }
  }

  onDone(sessionId, message) {
    if (this.session?.id !== sessionId) return;
    const i = this.session.messages.findIndex((x) => x.id === message.id);
    if (i >= 0) this.session.messages[i] = message; else this.session.messages.push(message);
    this.renderMessage(message, true);
    this.updatePrivacy();
  }

  onUpdated(sessionId, message) {
    this.onDone(sessionId, message);
  }

  onDeleted(sessionId, messageId) {
    if (this.session?.id !== sessionId) return;
    this.session.messages = this.session.messages.filter((x) => x.id !== messageId);
    this.nodes.get(messageId)?.remove();
    this.nodes.delete(messageId);
  }

  // ----- rendering -----

  isAtEnd() {
    const el = this.listEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  scrollToEnd(force) {
    if (force || this.isAtEnd()) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  renderMessage(m, live) {
    const existing = this.nodes.get(m.id);
    const node = this.buildNode(m);
    const atEnd = this.isAtEnd();
    if (existing) existing.replaceWith(node); else this.listEl.appendChild(node);
    this.nodes.set(m.id, node);
    if (live && (atEnd || m.sender === "user")) this.scrollToEnd(true);
  }

  buildNode(m) {
    const settings = this.ctx.settings;
    const wrap = document.createElement("div");
    const isUser = m.sender === "user";
    wrap.className = `msg ${isUser ? "user" : m.kind === "notice" || m.sender === "system" ? "notice" : "ai"}`;
    wrap.dataset.id = m.id;
    if (m.kind === "notice" || m.sender === "system") {
      wrap.innerHTML = `<div class="body"><div class="bubble">${escapeHtml(m.text)}</div></div>`;
      return wrap;
    }
    const contact = isUser ? null : this.contact(m.sender);
    wrap.appendChild(avatarEl(contact));
    const body = document.createElement("div");
    body.className = "body";
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = isUser ? t("you") : (contact?.nickname ?? m.sender);
    if (m.privateTo?.length) sender.innerHTML += ` <span class="lock" title="${escapeHtml(t("composer.whisperHint"))}">🔒</span>`;
    body.appendChild(sender);

    const bubble = document.createElement("div");
    bubble.className = "bubble" + (m.status === "streaming" ? " streaming" : "");
    // A reply to the message right before it needs no quote block; quotes are for references further back.
    const idx = this.session.messages.findIndex((x) => x.id === m.id);
    const prevId = idx > 0 ? this.session.messages[idx - 1].id : null;
    if (m.replyTo && m.replyTo !== prevId) {
      const q = this.session.messages.find((x) => x.id === m.replyTo);
      const qEl = document.createElement("div");
      qEl.className = "quote";
      qEl.textContent = q ? `${this.nick(q.sender)}: ${q.text.slice(0, 120)}` : t("msg.quoteDeleted");
      bubble.appendChild(qEl);
    }
    if (m.reasoning) {
      const d = document.createElement("details");
      d.className = "reasoning";
      d.innerHTML = `<summary>💭</summary><div>${escapeHtml(m.reasoning)}</div>`;
      bubble.appendChild(d);
    }
    const content = document.createElement("div");
    content.className = "content";
    content.innerHTML = renderMarkdown(m.text);
    bubble.appendChild(content);
    if (m.status === "streaming" && !m.text) {
      const ty = document.createElement("div");
      ty.className = "typing";
      ty.textContent = t("msg.typing");
      bubble.appendChild(ty);
    }
    body.appendChild(bubble);

    const foot = document.createElement("div");
    foot.className = "foot";
    const bits = [];
    if (m.status === "error") bits.push(`<span class="err">${escapeHtml(t("err." + (m.error?.code || "unknown")) + (m.error?.message && m.error.code !== "cancelled" ? ` (${m.error.message.slice(0, 160)})` : ""))}</span>`);
    else if (m.status === "cancelled") bits.push(`<span class="err">${escapeHtml(t("msg.cancelled"))}</span>`);
    else if (m.error?.code === "impersonation_cut") bits.push(`<span class="err">${escapeHtml(t("msg.impersonation"))}</span>`);
    else if (m.error?.code === "max_tokens") bits.push(`<span class="err">${escapeHtml(t("err.max_tokens"))}</span>`);
    if (!isUser && m.usage) {
      const u = m.usage;
      const costStr = formatCost(m.cost, settings);
      const est = u.estimated ? " est" : "";
      const cls = costClass(m.cost, settings);
      bits.push(`<span class="cost ${cls}${est}">${escapeHtml(costStr)}</span>`);
      const cached = u.cacheRead ? `（${t("cost.cached")} ${fmtTokens(u.cacheRead)}）` : "";
      bits.push(`<span>${t("cost.input")} ${fmtTokens(u.input + u.cacheRead)}${cached} / ${t("cost.output")} ${fmtTokens(u.output)}</span>`);
      if (m.latencyMs) bits.push(`<span>${(m.latencyMs / 1000).toFixed(1)}s</span>`);
      if (m.model) bits.push(`<span>${escapeHtml(m.model)}</span>`);
    }
    if (m.excludedFromContext) bits.push(`<span>${escapeHtml(t("msg.excluded"))}</span>`);
    if (m.versions?.length) bits.push(`<span>${m.versions.length} × ${escapeHtml(t("msg.regenerated"))}</span>`);
    const info = document.createElement("span");
    info.innerHTML = bits.join("<span>·</span>");
    if (m.contextInfo) info.title = t("msg.contextInfo", { n: m.contextInfo.historyCount, summary: m.contextInfo.summaryUsed ? t("privacy.summary") : "", tokens: fmtTokens(m.contextInfo.tokensEstimate) });
    foot.appendChild(info);
    foot.appendChild(this.actions(m));
    body.appendChild(foot);
    wrap.appendChild(body);
    return wrap;
  }

  actions(m) {
    const box = document.createElement("span");
    box.className = "actions";
    const btn = (label, title, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", fn);
      box.appendChild(b);
    };
    const s = this.session;
    if (m.status === "streaming") {
      btn("■", t("action.stop"), () => post(`/api/sessions/${s.id}/messages/${m.id}/cancel`));
      return box;
    }
    btn("↩", t("action.reply"), () => this.setReply(m));
    btn("⎘", t("action.copy"), async () => { try { await navigator.clipboard.writeText(m.text); this.ctx.toast(t("toast.copied")); } catch { /* ignore */ } });
    if (m.sender !== "user") btn("↻", t("action.regenerate"), () => post(`/api/sessions/${s.id}/messages/${m.id}/regenerate`).catch((e) => this.ctx.toast(e.message, true)));
    if (s.kind === "group") btn(m.excludedFromContext ? "👁" : "🙈", m.excludedFromContext ? t("action.include") : t("action.exclude"), () => patch(`/api/sessions/${s.id}/messages/${m.id}`, { excludedFromContext: !m.excludedFromContext }));
    btn("✕", t("action.delete"), () => del(`/api/sessions/${s.id}/messages/${m.id}`));
    return box;
  }
}
