// Side panel: members and role cards, cost summary, session settings. Resizable and maximizable.
import { t } from "./i18n.js";
import { escapeHtml } from "./markdown.js";
import { get, patch, del, getToken } from "./api.js";
import { avatarEl, formatCost } from "./chat.js";

export class Panel {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = document.getElementById("panel");
    this.body = document.getElementById("panel-body");
    this.tab = "members";
    this.session = null;
    document.getElementById("panel-close").addEventListener("click", () => this.hide());
    document.getElementById("panel-max").addEventListener("click", () => this.el.classList.toggle("max"));
    document.getElementById("panel-tabs").addEventListener("click", (e) => {
      const b = e.target.closest(".tab");
      if (!b) return;
      this.tab = b.dataset.tab;
      for (const x of e.currentTarget.querySelectorAll(".tab")) x.classList.toggle("active", x === b);
      this.render();
    });
    const resizer = document.getElementById("panel-resizer");
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.el.getBoundingClientRect().width;
      const move = (ev) => { this.el.style.width = Math.max(260, startW + (startX - ev.clientX)) + "px"; };
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); try { localStorage.setItem("polyphony.panelWidth", this.el.style.width); } catch { /* ignore */ } };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    try { const w = localStorage.getItem("polyphony.panelWidth"); if (w) this.el.style.width = w; } catch { /* ignore */ }
  }

  get visible() {
    return !this.el.classList.contains("hidden");
  }

  toggle(session) {
    this.session = session;
    if (this.visible) this.hide(); else this.show();
  }

  show() {
    this.el.classList.remove("hidden");
    this.render();
  }

  hide() {
    this.el.classList.add("hidden");
  }

  setSession(session) {
    this.session = session;
    if (this.visible) this.render();
  }

  refreshCost() {
    if (this.visible && this.tab === "cost") this.render();
  }

  render() {
    const s = this.session;
    if (!s) { this.body.innerHTML = ""; return; }
    if (this.tab === "members") this.renderMembers(s);
    else if (this.tab === "cost") this.renderCost(s);
    else this.renderSettings(s);
  }

  renderMembers(s) {
    this.body.innerHTML = "";
    for (const m of s.members) {
      const c = this.ctx.contacts.find((x) => x.id === m.contactId);
      const row = document.createElement("div");
      row.className = "member-row";
      row.appendChild(avatarEl(c));
      const info = document.createElement("div");
      info.className = "info";
      const a = c ? this.ctx.accounts.find((x) => x.id === c.accountId) : null;
      info.innerHTML = `<div class="name">${escapeHtml(c?.nickname ?? m.contactId)}</div><div class="desc">${escapeHtml(c?.id === "deskdock" ? t("deskdock") : `${a?.name ?? ""} · ${c?.model ?? ""}`)}</div>`;
      if (m.contactId === "deskdock") {
        const sel = document.createElement("select");
        const ds = this.ctx.contacts.filter((x) => x.enabled && x.id !== "deskdock" && x.supportsTools && this.ctx.accounts.find((a) => a.id === x.accountId)?.provider !== "cli");
        sel.innerHTML = `<option value="">${escapeHtml(t("dd.driverNone"))}</option>` + ds.map((x) => `<option value="${x.id}" ${m.driverContactId === x.id ? "selected" : ""}>${escapeHtml(x.nickname)}</option>`).join("");
        sel.title = t("dd.driver");
        sel.style.marginTop = "6px";
        sel.addEventListener("change", async () => {
          const members = s.members.map((x) => (x.contactId === "deskdock" ? { ...x, driverContactId: sel.value || undefined } : x));
          const updated = await patch(`/api/sessions/${s.id}`, { members });
          this.ctx.onSessionPatched(updated);
          this.ctx.toast(t("toast.saved"));
        });
        info.appendChild(sel);
      }
      if (s.kind === "group") {
        const ta = document.createElement("textarea");
        ta.rows = 3;
        ta.placeholder = t("panel.roleCard");
        ta.value = m.roleCard ?? "";
        ta.addEventListener("change", async () => {
          const members = s.members.map((x) => (x.contactId === m.contactId ? { ...x, roleCard: ta.value } : x));
          const updated = await patch(`/api/sessions/${s.id}`, { members });
          this.ctx.onSessionPatched(updated);
          this.ctx.toast(t("toast.saved"));
        });
        info.appendChild(ta);
      }
      row.appendChild(info);
      this.body.appendChild(row);
    }
  }

  async renderCost(s) {
    const settings = this.ctx.settings;
    let data;
    try { data = await get(`/api/ledger?sessionId=${encodeURIComponent(s.id)}`); } catch { return; }
    const fmt = (usd) => formatCost({ usd, cny: usd * settings.usdToCny, priced: true, kind: "metered" }, settings);
    const rows = [
      [t("cost.session"), fmt(data.sessionUsd)],
      [t("cost.today"), fmt(data.todayUsd)],
      [t("cost.all"), fmt(data.allUsd)],
    ];
    let html = rows.map(([k, v]) => `<div class="stat"><span>${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`).join("");
    if (s.budget?.total) {
      const pct = Math.min(100, (s.spentTotal / s.budget.total) * 100);
      html += `<div class="section-title">${escapeHtml(t("cost.budget"))}</div><div class="stat"><span>${escapeHtml(t("cost.total"))}</span><span class="v">${escapeHtml(fmt(s.spentTotal))} / ${escapeHtml(fmt(s.budget.total))}</span></div><div class="bar"><div style="width:${pct}%"></div></div>`;
    }
    if (s.budget?.perRound) html += `<div class="stat"><span>${escapeHtml(t("cost.perRound"))}</span><span class="v">${escapeHtml(fmt(s.budget.perRound))}</span></div>`;
    html += `<div class="section-title">${escapeHtml(t("cost.byProvider"))}</div>`;
    for (const [k, v] of Object.entries(data.byProvider ?? {})) {
      html += `<div class="stat"><span>${escapeHtml(k)} <span class="hint">${escapeHtml(t("cost.calls", { n: v.calls }))}</span></span><span class="v">${escapeHtml(fmt(v.usd))}</span></div>`;
    }
    this.body.innerHTML = html;
  }

  renderSettings(s) {
    const f = (label, input, hint) => `<div class="field"><label>${escapeHtml(label)}</label>${input}${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}</div>`;
    const orders = ["list", "random", "host", "race"];
    let html = f(t("session.title"), `<input id="p-title" value="${escapeHtml(s.title)}">`);
    if (s.kind === "group") {
      html += f(t("session.intro"), `<textarea id="p-intro">${escapeHtml(s.intro)}</textarea>`, t("session.introHint"));
      html += `<div class="row">${f(t("cost.perRound") + " ($)", `<input id="p-per-round" type="number" min="0" step="0.1" value="${s.budget?.perRound ?? ""}">`)}${f(t("cost.total") + " ($)", `<input id="p-total" type="number" min="0" step="0.1" value="${s.budget?.total ?? ""}">`)}</div>`;
      html += `<label class="check"><input type="checkbox" id="p-mentions" ${s.allowModelMentions ? "checked" : ""}> ${escapeHtml(t("session.allowMentions"))}</label>`;
      html += f(t("session.order"), `<select id="p-order">${orders.map((o) => `<option value="${o}" ${s.speakingOrder === o ? "selected" : ""}>${escapeHtml(t("session.order." + o))}</option>`).join("")}</select>`);
      html += f(t("session.gap"), `<input id="p-gap" type="number" min="0" value="${s.roundGapSec}">`);
    }
    html += `<div class="section-title">${escapeHtml(t("session.context"))}</div><div class="row">${f(t("session.recentCount"), `<input id="p-count" type="number" min="1" value="${s.context.recentCount}">`)}${f(t("session.recentTokens"), `<input id="p-tokens" type="number" min="500" step="500" value="${s.context.recentTokens}">`)}</div>`;
    html += `<div class="row" style="margin-top:8px"><button class="btn primary" id="p-save">${escapeHtml(t("action.save"))}</button><button class="btn" id="p-pin">${escapeHtml(s.pinned ? t("session.unpin") : t("session.pin"))}</button><button class="btn" id="p-export">${escapeHtml(t("action.export"))}</button><button class="btn danger" id="p-del">${escapeHtml(t("action.delete"))}</button></div>`;
    this.body.innerHTML = html;
    const q = (id) => this.body.querySelector(id);
    q("#p-save").addEventListener("click", async () => {
      const body = { title: q("#p-title").value.trim(), context: { recentCount: Number(q("#p-count").value) || 12, recentTokens: Number(q("#p-tokens").value) || 6000 } };
      if (s.kind === "group") {
        body.intro = q("#p-intro").value;
        body.allowModelMentions = q("#p-mentions").checked;
        body.speakingOrder = q("#p-order").value;
        body.roundGapSec = Number(q("#p-gap").value) || 0;
        body.budget = {};
        if (Number(q("#p-per-round").value) > 0) body.budget.perRound = Number(q("#p-per-round").value);
        if (Number(q("#p-total").value) > 0) body.budget.total = Number(q("#p-total").value);
      }
      const updated = await patch(`/api/sessions/${s.id}`, body);
      this.ctx.onSessionPatched(updated);
      this.ctx.toast(t("toast.saved"));
    });
    q("#p-export").addEventListener("click", () => window.open(`/api/sessions/${s.id}/export?token=${encodeURIComponent(getToken())}`, "_blank"));
    q("#p-pin").addEventListener("click", async () => {
      const updated = await patch(`/api/sessions/${s.id}`, { pinned: !s.pinned });
      this.ctx.onSessionPatched(updated);
      this.render();
    });
    q("#p-del").addEventListener("click", async () => {
      if (!confirm(t("session.deleteConfirm"))) return;
      await del(`/api/sessions/${s.id}`);
      this.hide();
    });
  }
}
