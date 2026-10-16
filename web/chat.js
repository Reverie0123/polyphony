// Message list, composer, privacy line, attachments. Talks to app state through the `ctx` object passed in.
import { t } from "./i18n.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import { post, del, patch, getToken, uploadFile } from "./api.js";
import { openModal } from "./modal.js";

export function formatCost(cost, settings) {
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
  // unpriced-alert: a metered call with no price is shown in red so it is never mistaken for free.
  if (cost && cost.kind === "metered" && !cost.priced) return "alert";
  if (!cost || !cost.priced || cost.kind !== "metered") return "";
  if (cost.cny >= settings.costAlert) return "alert";
  if (cost.cny >= settings.costWarn) return "warn";
  return "";
}

function fmtTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

export function attachmentUrl(hash) {
  return `/api/attachments/${hash}?token=${encodeURIComponent(getToken())}`;
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
    this.editBar = document.getElementById("edit-bar");
    this.attachRow = document.getElementById("attach-row");
    this.pinnedStrip = document.getElementById("pinned-strip");
    this.whisperLabel = document.getElementById("whisper-label");
    this.whisper = document.getElementById("whisper");
    this.fileInput = document.getElementById("file-input");
    this.session = null;
    this.mentions = new Set();
    this.replyTo = null;
    this.editingFrom = null;
    this.pendingAttachments = [];
    this.previewTimer = null;
    this.nodes = new Map();

    this.sendBtn.addEventListener("click", () => this.send());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      if (e.key === "Escape") { this.setReply(null); this.setEditing(null); }
    });
    this.input.addEventListener("input", () => { this.autosize(); this.schedulePreview(); });
    this.input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); this.addFiles(files); }
    });
    this.whisper.addEventListener("change", () => this.schedulePreview());
    document.getElementById("btn-attach").addEventListener("click", () => this.fileInput.click());
    this.fileInput.addEventListener("change", () => { this.addFiles([...this.fileInput.files]); this.fileInput.value = ""; });
    this.listEl.addEventListener("dragover", (e) => { e.preventDefault(); });
    this.listEl.addEventListener("drop", (e) => { e.preventDefault(); this.addFiles([...(e.dataTransfer?.files ?? [])]); });
  }

  autosize() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(200, this.input.scrollHeight) + "px";
  }

  open(session) {
    this.session = session;
    this.mentions = new Set();
    this.replyTo = null;
    this.editingFrom = null;
    this.pendingAttachments = [];
    this.nodes.clear();
    this.listEl.innerHTML = "";
    this.replyBar.classList.add("hidden");
    this.editBar.classList.add("hidden");
    this.renderAttachRow();
    const group = session.kind === "group";
    this.whisperLabel.classList.toggle("hidden", !group);
    this.renderMentionRow();
    for (const m of session.messages) this.renderMessage(m, false);
    this.renderPinned();
    this.scrollToEnd(true);
    this.updatePrivacy();
    this.input.focus();
  }

  contact(id) {
    return this.ctx.contacts.find((c) => c.id === id);
  }

  nick(id) {
    if (id === "user") return t("you");
    if (id === "system") return "";
    return this.contact(id)?.nickname ?? id;
  }

  // ----- composer -----

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

  async addFiles(files) {
    for (const f of files) {
      try {
        const att = await uploadFile(f);
        this.pendingAttachments.push(att);
      } catch (err) {
        this.ctx.toast(t("upload.failed", { err: err.message }), true);
      }
    }
    this.renderAttachRow();
  }

  renderAttachRow() {
    const row = this.attachRow;
    row.innerHTML = "";
    row.classList.toggle("hidden", !this.pendingAttachments.length);
    this.pendingAttachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      if (a.mime.startsWith("image/")) { const img = document.createElement("img"); img.src = attachmentUrl(a.hash); chip.appendChild(img); }
      const n = document.createElement("span"); n.className = "n"; n.textContent = `${a.name} (${fmtSize(a.size)})`; chip.appendChild(n);
      const x = document.createElement("button"); x.textContent = "✕"; x.addEventListener("click", () => { this.pendingAttachments.splice(i, 1); this.renderAttachRow(); }); chip.appendChild(x);
      row.appendChild(chip);
    });
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

  setEditing(message) {
    this.editingFrom = message ? message.id : null;
    if (!message) { this.editBar.classList.add("hidden"); return; }
    this.editBar.classList.remove("hidden");
    this.editBar.innerHTML = `<span>✎ ${escapeHtml(t("msg.editing"))}</span><button class="icon-btn" style="width:20px;height:20px">✕</button>`;
    this.editBar.querySelector("button").addEventListener("click", () => this.setEditing(null));
    this.input.value = message.text;
    this.mentions = new Set(message.mentions ?? []);
    this.renderMentionRow();
    this.autosize();
    this.input.focus();
  }

  async send() {
    const s = this.session;
    const text = this.input.value.trim();
    if (!s || (!text && !this.pendingAttachments.length)) return;
    const body = {
      text, mentions: [...this.mentions], replyTo: this.replyTo?.id, whisper: this.whisper.checked,
      attachments: this.pendingAttachments.map((a) => a.hash), editedFrom: this.editingFrom ?? undefined,
    };
    const keepAttachments = this.pendingAttachments;
    this.input.value = "";
    this.autosize();
    this.setReply(null);
    this.setEditing(null);
    this.pendingAttachments = [];
    this.renderAttachRow();
    try {
      await post(`/api/sessions/${s.id}/messages`, body);
    } catch (err) {
      this.ctx.toast(err.message, true);
      this.input.value = text;
      this.pendingAttachments = keepAttachments;
      this.renderAttachRow();
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
    this.renderPinned();
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
    this.renderPinned();
  }

  // ----- rendering -----

  isAtEnd() {
    const el = this.listEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  scrollToEnd(force) {
    if (force || this.isAtEnd()) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  scrollTo(messageId) {
    const node = this.nodes.get(messageId);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.classList.add("highlight");
    setTimeout(() => node.classList.remove("highlight"), 2000);
  }

  renderPinned() {
    const pinned = (this.session?.messages ?? []).filter((m) => m.pinned);
    this.pinnedStrip.classList.toggle("hidden", !pinned.length);
    this.pinnedStrip.innerHTML = pinned.length ? `<b>${escapeHtml(t("pinned.title"))}</b>` : "";
    for (const m of pinned) {
      const sp = document.createElement("span");
      sp.textContent = `📌 ${this.nick(m.sender)}: ${m.text.slice(0, 40)}`;
      sp.addEventListener("click", () => this.scrollTo(m.id));
      this.pinnedStrip.appendChild(sp);
    }
  }

  renderMessage(m, live) {
    const existing = this.nodes.get(m.id);
    const node = this.buildNode(m);
    const atEnd = this.isAtEnd();
    if (existing) existing.replaceWith(node); else this.listEl.appendChild(node);
    this.nodes.set(m.id, node);
    if (live && (atEnd || m.sender === "user")) this.scrollToEnd(true);
  }

  buildAttachments(m) {
    const box = document.createElement("div");
    for (const a of m.attachments ?? []) {
      if (a.mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.className = "att";
        img.src = attachmentUrl(a.hash);
        img.alt = a.name;
        img.addEventListener("click", () => window.open(img.src, "_blank"));
        box.appendChild(img);
        const cap = document.createElement("div");
        cap.className = "att-caption";
        if (a.caption) {
          const by = a.captionBy === "ocr" ? "OCR" : a.captionBy;
          const cost = a.captionCost && a.captionCost.kind === "metered" ? ` · ${formatCost(a.captionCost, this.ctx.settings)}` : "";
          cap.innerHTML = `<span class="by">${escapeHtml(t("msg.imageBy", { by }))}${escapeHtml(cost)}</span>${escapeHtml(a.caption)}`;
        } else if (a.captionError) cap.textContent = t("msg.imageError", { err: a.captionError });
        else cap.textContent = t("msg.imagePending");
        box.appendChild(cap);
      } else {
        const chip = document.createElement("a");
        chip.className = "file-chip";
        chip.href = attachmentUrl(a.hash);
        chip.target = "_blank";
        chip.innerHTML = `📄 <span>${escapeHtml(a.name)}</span> <span class="size">${fmtSize(a.size)}</span>`;
        box.appendChild(chip);
      }
    }
    return box;
  }

  buildSteps(m) {
    const box = document.createElement("div");
    box.className = "steps";
    m.steps.forEach((st, i) => {
      const d = document.createElement("details");
      d.className = "step" + (st.endedAt ? "" : " running");
      const status = st.endedAt ? (st.ok ? `<span class="ok">✓ ${escapeHtml(t("dd.stepOk"))}</span>` : `<span class="fail">✗ ${escapeHtml(t("dd.stepFail"))}</span>`) : "";
      d.innerHTML = `<summary><span>${i + 1}.</span><span class="tool">${escapeHtml(st.tool)}</span>${status}</summary><div class="args">${escapeHtml(st.argsSummary)}</div><div class="result">${escapeHtml(st.resultSummary || "")}</div>`;
      box.appendChild(d);
    });
    if (m.status === "streaming" && !m.steps.length) box.innerHTML = `<div class="typing">${escapeHtml(t("dd.working"))}</div>`;
    return box;
  }

  buildNode(m) {
    const settings = this.ctx.settings;
    const wrap = document.createElement("div");
    const isUser = m.sender === "user";
    wrap.className = `msg ${isUser ? "user" : m.kind === "notice" || m.sender === "system" ? "notice" : "ai"}`;
    wrap.dataset.id = m.id;
    if (m.kind === "notice" || m.sender === "system") {
      wrap.innerHTML = `<div class="body"><div class="bubble">${escapeHtml(m.text)}</div></div>`;
      if (m.action?.type === "mention") {
        const card = document.createElement("div");
        card.className = "mention-card";
        if (m.action.status === "pending") {
          const ok = document.createElement("button"); ok.className = "btn primary"; ok.textContent = t("mention.approve");
          const no = document.createElement("button"); no.className = "btn"; no.textContent = t("mention.reject");
          ok.addEventListener("click", () => post(`/api/sessions/${this.session.id}/mentions/${m.action.id}/approve`).catch((e) => this.ctx.toast(e.message, true)));
          no.addEventListener("click", () => post(`/api/sessions/${this.session.id}/mentions/${m.action.id}/reject`).catch((e) => this.ctx.toast(e.message, true)));
          card.append(ok, no);
        } else {
          card.innerHTML = `<span class="hint">${escapeHtml(t(m.action.status === "approved" ? "mention.approved" : "mention.rejected"))}</span>`;
        }
        wrap.querySelector(".body").appendChild(card);
      }
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
    if (m.starred) sender.innerHTML += ` <span class="star">★</span>`;
    if (m.forwardedFrom) {
      const src = this.ctx.sessions.find((s) => s.id === m.forwardedFrom.sessionId);
      sender.innerHTML += ` <span class="lock">${escapeHtml(t("msg.forwarded", { title: src?.title ?? "?" }))}</span>`;
    }
    body.appendChild(sender);

    // A regenerated reply folds away as "previous version".
    if (m.supersededAt && !isUser) {
      const d = document.createElement("details");
      d.className = "folded";
      d.innerHTML = `<summary>${escapeHtml(t("msg.superseded"))}</summary><div class="bubble">${renderMarkdown(m.text)}</div>`;
      body.appendChild(d);
      wrap.appendChild(body);
      return wrap;
    }
    // A user message superseded by an edit folds away.
    const supersededBy = isUser && m.excludedFromContext ? this.session.messages.find((x) => x.editedFrom === m.id) : null;
    if (supersededBy) {
      const d = document.createElement("details");
      d.className = "folded";
      d.innerHTML = `<summary>${escapeHtml(t("msg.foldedOriginal"))}</summary><div class="bubble">${renderMarkdown(m.text)}</div>`;
      body.appendChild(d);
      wrap.appendChild(body);
      return wrap;
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble" + (m.status === "streaming" ? " streaming" : "");
    const idx = this.session.messages.findIndex((x) => x.id === m.id);
    const prevId = idx > 0 ? this.session.messages[idx - 1].id : null;
    // Discussion turns all answer the topic post; quoting it on every turn is noise.
    if (m.replyTo && m.replyTo !== prevId && m.round === undefined) {
      const q = this.session.messages.find((x) => x.id === m.replyTo);
      const qEl = document.createElement("div");
      qEl.className = "quote";
      qEl.textContent = q ? `${this.nick(q.sender)}: ${q.text.slice(0, 120)}` : t("msg.quoteDeleted");
      if (q) qEl.addEventListener("click", () => this.scrollTo(q.id));
      bubble.appendChild(qEl);
    }
    if (m.reasoning) {
      const d = document.createElement("details");
      d.className = "reasoning";
      d.innerHTML = `<summary>💭</summary><div>${escapeHtml(m.reasoning)}</div>`;
      bubble.appendChild(d);
    }
    if (m.attachments?.length) bubble.appendChild(this.buildAttachments(m));
    if (m.kind === "steps" && m.steps) bubble.appendChild(this.buildSteps(m));
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
    if (m.editedFrom) bits.push(`<span>${escapeHtml(t("msg.edited"))}</span>`);
    if (m.excludedFromContext && !isUser) bits.push(`<span>${escapeHtml(t("msg.excluded"))}</span>`);
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
    const url = (suffix) => `/api/sessions/${s.id}/messages/${m.id}${suffix}`;
    if (m.status === "streaming") {
      btn("■", t("action.stop"), () => post(url("/cancel")));
      return box;
    }
    btn("↩", t("action.reply"), () => this.setReply(m));
    btn("⎘", t("action.copy"), async () => { try { await navigator.clipboard.writeText(m.text); this.ctx.toast(t("toast.copied")); } catch { /* ignore */ } });
    if (m.sender === "user") btn("✎", t("action.edit"), () => this.setEditing(m));
    else if (m.kind !== "steps") btn("↻", t("action.regenerate"), () => post(url("/regenerate")).catch((e) => this.ctx.toast(e.message, true))); // a DeskDock task is re-run by mentioning it again
    btn(m.starred ? "★" : "☆", m.starred ? t("action.unstar") : t("action.star"), () => patch(url(""), { starred: !m.starred }));
    btn(m.pinned ? "📍" : "📌", m.pinned ? t("action.unpin") : t("action.pin"), () => patch(url(""), { pinned: !m.pinned }));
    btn("➦", t("action.forward"), () => this.forwardDialog(m));
    if (s.kind === "group") btn(m.excludedFromContext ? "👁" : "🙈", m.excludedFromContext ? t("action.include") : t("action.exclude"), () => patch(url(""), { excludedFromContext: !m.excludedFromContext }));
    btn("✕", t("action.delete"), () => del(url("")));
    return box;
  }

  forwardDialog(m) {
    const others = this.ctx.sessions.filter((s) => s.id !== this.session.id);
    const html = `<div class="pick-list">${others.map((s) => `<div class="pick-row" data-id="${s.id}"><span class="grow">${escapeHtml(s.title)}</span></div>`).join("") || `<div class="hint" style="padding:10px">—</div>`}</div>`;
    const { modal, close } = openModal(this.ctx, { title: t("forward.title"), bodyHtml: html, buttons: [{ label: t("action.cancel") }] });
    modal.querySelectorAll(".pick-row").forEach((row) => row.addEventListener("click", async () => {
      try { await post(`/api/sessions/${this.session.id}/messages/${m.id}/forward`, { targetSessionId: row.dataset.id }); this.ctx.toast(t("toast.saved")); } catch (e) { this.ctx.toast(e.message, true); }
      close();
    }));
  }
}
