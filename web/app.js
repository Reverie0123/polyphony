// App shell: bootstrap, session list, SSE wiring, settings modal.
import { t, setLang, lang } from "./i18n.js";
import { initToken, setToken, get, post, patch, put, connectEvents } from "./api.js";
import { escapeHtml } from "./markdown.js";
import { ChatView, avatarEl, formatCost } from "./chat.js";
import { Panel } from "./panel.js";
import { openContacts, openNewSession, openModal } from "./contacts.js";

const ctx = {
  settings: {},
  accounts: [],
  contacts: [],
  sessions: [],
  version: "",
  toast(msg, isError) {
    const root = document.getElementById("toast-root");
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.remove(), isError ? 5000 : 2200);
  },
  async reload() {
    const b = await get("/api/bootstrap");
    ctx.settings = b.settings;
    ctx.accounts = b.accounts;
    ctx.contacts = b.contacts;
    ctx.sessions = b.sessions;
    ctx.version = b.version;
    ctx.lan = { addresses: b.lanAddresses, token: b.lanToken };
    applyTheme();
    renderSessionList();
    document.getElementById("sidebar-foot").innerHTML = `<span>Polyphony ${escapeHtml(b.version)}</span>`;
  },
  onSessionPatched(updated) {
    const i = ctx.sessions.findIndex((s) => s.id === updated.id);
    const { messages, ...meta } = updated;
    if (i >= 0) ctx.sessions[i] = { ...ctx.sessions[i], ...meta };
    if (current && current.id === updated.id) { Object.assign(current, meta); chat.renderMentionRow(); updateHeader(); }
    renderSessionList();
  },
};

let current = null;
const chat = new ChatView(ctx);
const panel = new Panel(ctx);

function applyTheme() {
  const th = ctx.settings.theme;
  if (th === "light" || th === "dark") document.documentElement.dataset.theme = th;
  else delete document.documentElement.dataset.theme;
  setLang(ctx.settings.lang);
}

function renderSessionList() {
  const list = document.getElementById("session-list");
  list.innerHTML = "";
  for (const s of ctx.sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (current?.id === s.id ? " active" : "");
    const stack = document.createElement("div");
    stack.className = "avatar-stack";
    for (const m of s.members.slice(0, 3)) stack.appendChild(avatarEl(ctx.contacts.find((c) => c.id === m.contactId), "sm"));
    item.appendChild(stack);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<div class="name">${s.pinned ? `<span class="pin">📌</span>` : ""}<span>${escapeHtml(s.title)}</span></div><div class="last">${escapeHtml(s.lastMessage ?? "")}</div>`;
    item.appendChild(meta);
    item.addEventListener("click", () => openSession(s.id));
    list.appendChild(item);
  }
}

function updateHeader() {
  if (!current) return;
  document.getElementById("chat-title").textContent = current.title;
  const names = current.members.map((m) => ctx.contacts.find((c) => c.id === m.contactId)?.nickname ?? m.contactId);
  const spent = formatCost({ usd: current.spentTotal, cny: current.spentTotal * ctx.settings.usdToCny, priced: true, kind: "metered" }, ctx.settings);
  document.getElementById("chat-subtitle").textContent = `${current.kind === "group" ? names.join("、") : names[0]} · ${spent}`;
}

async function openSession(id) {
  try {
    current = await get(`/api/sessions/${id}`);
  } catch (err) { ctx.toast(err.message, true); return; }
  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("chat").classList.remove("hidden");
  document.getElementById("app").classList.add("in-chat");
  updateHeader();
  chat.open(current);
  panel.setSession(current);
  renderSessionList();
}

function closeSession() {
  current = null;
  document.getElementById("chat").classList.add("hidden");
  document.getElementById("empty-state").classList.remove("hidden");
  document.getElementById("app").classList.remove("in-chat");
  panel.hide();
  renderSessionList();
}

function openSettings() {
  const s = ctx.settings;
  const f = (label, input, hint) => `<div class="field"><label>${escapeHtml(label)}</label>${input}${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}</div>`;
  const sel = (id, value, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${value === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>`;
  const lanInfo = s.lanAccess && ctx.lan?.addresses?.length
    ? `<div class="hint">${escapeHtml(t("settings.lanUrl"))} ${ctx.lan.addresses.map((a) => `http://${a}:${s.port}/?token=${encodeURIComponent(ctx.lan.token ?? "")}`).map(escapeHtml).join("<br>")}</div>`
    : "";
  const html = `
    <div class="row">
      ${f(t("settings.lang"), sel("s-lang", s.lang, [["auto", t("settings.lang.auto")], ["zh", "中文"], ["en", "English"]]))}
      ${f(t("settings.theme"), sel("s-theme", s.theme, [["auto", t("settings.theme.auto")], ["light", t("settings.theme.light")], ["dark", t("settings.theme.dark")]]))}
    </div>
    <div class="row">
      ${f(t("settings.currency"), sel("s-currency", s.currency, [["cny", "¥ CNY"], ["usd", "$ USD"]]))}
      ${f(t("settings.rate"), `<input id="s-rate" type="number" step="0.01" value="${s.usdToCny}">`)}
    </div>
    <div class="row">
      ${f(t("settings.costWarn"), `<input id="s-warn" type="number" step="0.1" value="${s.costWarn}">`)}
      ${f(t("settings.costAlert"), `<input id="s-alert" type="number" step="0.1" value="${s.costAlert}">`)}
    </div>
    <div class="row">
      ${f(t("settings.autoExit"), `<input id="s-exit" type="number" min="0" value="${s.autoExitMinutes}">`)}
      ${f(t("settings.concurrency"), `<input id="s-conc" type="number" min="1" max="16" value="${s.concurrency}">`)}
    </div>
    <label class="check"><input type="checkbox" id="s-cli" ${s.cliEnabled ? "checked" : ""}> ${escapeHtml(t("settings.cliEnabled"))}</label>
    <label class="check"><input type="checkbox" id="s-lan" ${s.lanAccess ? "checked" : ""}> ${escapeHtml(t("settings.lan"))}</label>
    ${lanInfo}
    <div class="section-title">${escapeHtml(t("settings.pricing"))}</div>
    <div class="hint">${escapeHtml(t("settings.pricingHint"))}</div>
    <div class="row" style="margin:8px 0"><button class="btn sm" id="s-refresh">${escapeHtml(t("settings.refreshPricing"))}</button><span class="hint" id="s-fetched"></span></div>
    <div id="s-pricing"></div>
    <div class="section-title">${escapeHtml(t("settings.version"))}</div>
    <div class="hint">Polyphony ${escapeHtml(ctx.version)}</div>`;
  openModal(ctx, {
    title: t("settings.title"),
    bodyHtml: html,
    wide: true,
    buttons: [
      { label: t("action.cancel") },
      {
        label: t("action.save"), primary: true,
        onClick: async (modal) => {
          const q = (id) => modal.querySelector(id);
          await patch("/api/settings", {
            lang: q("#s-lang").value, theme: q("#s-theme").value, currency: q("#s-currency").value,
            usdToCny: Number(q("#s-rate").value) || 7.2, costWarn: Number(q("#s-warn").value), costAlert: Number(q("#s-alert").value),
            autoExitMinutes: Number(q("#s-exit").value), concurrency: Number(q("#s-conc").value) || 4,
            cliEnabled: q("#s-cli").checked, lanAccess: q("#s-lan").checked,
          });
          await ctx.reload();
          if (current) { updateHeader(); chat.open(current); }
          ctx.toast(t("toast.saved"));
        },
      },
    ],
    onOpen: async (modal) => {
      const box = modal.querySelector("#s-pricing");
      const fetched = modal.querySelector("#s-fetched");
      const load = async () => {
        const data = await get("/api/pricing");
        fetched.textContent = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : "";
        const used = new Set(ctx.contacts.map((c) => c.model.toLowerCase()));
        const rows = data.table.filter((r) => used.size === 0 || [...used].some((u) => u.includes(r.model) || r.model.includes(u)) || r.source === "override");
        const show = rows.length ? rows : data.table.slice(0, 12);
        box.innerHTML = `<table class="pricing"><tr><th>model</th><th>in</th><th>out</th><th>cache r</th><th>cache w</th><th></th></tr>${show.map((r) => `<tr data-model="${escapeHtml(r.model)}"><td>${escapeHtml(r.model)} <span class="pill">${r.source}</span></td><td><input value="${r.price.input}"></td><td><input value="${r.price.output}"></td><td><input value="${r.price.cacheRead}"></td><td><input value="${r.price.cacheWrite}"></td><td><button class="btn sm" data-save>✓</button></td></tr>`).join("")}</table>`;
        box.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
          const tr = b.closest("tr");
          const [i, o, cr, cw] = [...tr.querySelectorAll("input")].map((x) => Number(x.value));
          await put(`/api/pricing/${encodeURIComponent(tr.dataset.model)}`, { price: { input: i, output: o, cacheRead: cr, cacheWrite: cw } });
          ctx.toast(t("toast.saved"));
          load();
        }));
      };
      modal.querySelector("#s-refresh").addEventListener("click", async (e) => { e.currentTarget.disabled = true; try { await post("/api/pricing/refresh"); await load(); } finally { e.currentTarget.disabled = false; } });
      await load();
    },
  });
}

function wireEvents() {
  connectEvents({
    "message.created": ({ sessionId, message }) => { chat.onCreated(sessionId, message); bumpSession(sessionId, message); },
    "message.delta": ({ sessionId, messageId, text }) => chat.onDelta(sessionId, messageId, text),
    "message.status": ({ sessionId, messageId, status }) => chat.onStatus(sessionId, messageId, status),
    "message.done": async ({ sessionId, message }) => {
      chat.onDone(sessionId, message);
      bumpSession(sessionId, message);
      if (current?.id === sessionId && message.cost) { current.spentTotal += message.cost.usd; updateHeader(); }
    },
    "message.updated": ({ sessionId, message }) => chat.onUpdated(sessionId, message),
    "message.deleted": ({ sessionId, messageId }) => chat.onDeleted(sessionId, messageId),
    "ledger.updated": () => panel.refreshCost(),
    "session.created": ({ session }) => { if (!ctx.sessions.some((s) => s.id === session.id)) { ctx.sessions.unshift(session); renderSessionList(); } },
    "session.updated": ({ session }) => ctx.onSessionPatched(session),
    "session.deleted": ({ sessionId }) => { ctx.sessions = ctx.sessions.filter((s) => s.id !== sessionId); if (current?.id === sessionId) closeSession(); else renderSessionList(); },
    __open: () => {},
  });
}

function bumpSession(sessionId, message) {
  const s = ctx.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (message.text) s.lastMessage = message.text.slice(0, 80);
  s.updatedAt = message.createdAt;
  ctx.sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
  renderSessionList();
}

async function boot() {
  const token = initToken();
  setToken(token);
  setLang("auto");
  try {
    await ctx.reload();
  } catch (err) {
    document.body.innerHTML = `<div class="empty"><h2>Polyphony</h2><p>${escapeHtml(err.status === 401 ? (lang() === "zh" ? "缺少令牌：请从桌面快捷方式或命令行重新打开。" : "Missing token: open the app from its shortcut or the command line.") : err.message)}</p></div>`;
    return;
  }
  wireEvents();
  document.getElementById("btn-new").addEventListener("click", () => openNewSession(ctx, (s) => { ctx.sessions.unshift({ ...s, lastMessage: "" }); openSession(s.id); }));
  document.getElementById("empty-new").addEventListener("click", () => document.getElementById("btn-new").click());
  document.getElementById("btn-contacts").addEventListener("click", () => openContacts(ctx));
  document.getElementById("empty-contacts").addEventListener("click", () => openContacts(ctx));
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-panel").addEventListener("click", () => panel.toggle(current));
  document.getElementById("btn-back").addEventListener("click", closeSession);
  wireSearch();
  if (ctx.sessions.length) openSession(ctx.sessions[0].id);
}

function wireSearch() {
  const box = document.getElementById("search");
  const results = document.getElementById("search-results");
  const list = document.getElementById("session-list");
  let timer = null;
  box.addEventListener("input", () => {
    clearTimeout(timer);
    const q = box.value.trim();
    if (!q) { results.classList.add("hidden"); list.classList.remove("hidden"); return; }
    timer = setTimeout(async () => {
      let data;
      try { data = await get("/api/search?q=" + encodeURIComponent(q)); } catch { return; }
      results.innerHTML = "";
      list.classList.add("hidden");
      results.classList.remove("hidden");
      if (!data.results.length) { results.innerHTML = `<div class="hint" style="padding:10px">${escapeHtml(t("search.none"))}</div>`; return; }
      for (const r of data.results) {
        const item = document.createElement("div");
        item.className = "session-item search-hit";
        const who = r.sender === "user" ? t("you") : (ctx.contacts.find((c) => c.id === r.sender)?.nickname ?? r.sender);
        item.innerHTML = `<div class="meta"><div class="name">${escapeHtml(r.title)}</div><div class="snippet">${escapeHtml(who)}: ${escapeHtml(r.snippet)}</div></div>`;
        item.addEventListener("click", async () => { await openSession(r.sessionId); chat.scrollTo(r.messageId); });
        results.appendChild(item);
      }
    }, 250);
  });
}

boot();
