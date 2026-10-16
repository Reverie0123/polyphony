// Accounts and contacts management modal, plus the new-session wizard.
import { t } from "./i18n.js";
import { escapeHtml } from "./markdown.js";
import { get, post, patch, del } from "./api.js";
import { avatarEl } from "./chat.js";
import { openModal } from "./modal.js";
import { templates } from "./templates.js";
export { openModal };

const DEFAULT_URLS = { openai: "https://api.deepseek.com/v1", anthropic: "https://api.anthropic.com", ollama: "http://127.0.0.1:11434", cli: "" };

function field(label, inputHtml, hint) {
  return `<div class="field"><label>${escapeHtml(label)}</label>${inputHtml}${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}</div>`;
}

export function openContacts(ctx) {
  const render = (modal) => {
    const body = modal.querySelector(".modal-body");
    const accounts = ctx.accounts;
    const contacts = ctx.contacts;
    body.innerHTML = `
      <div class="two-col">
        <div>
          <div class="section-title">${escapeHtml(t("contacts.accounts"))}</div>
          <div class="list" id="acc-list">${accounts.length ? "" : `<div class="hint">${escapeHtml(t("contacts.noAccounts"))}</div>`}</div>
          <button class="btn sm" id="add-acc" style="margin-top:8px">＋ ${escapeHtml(t("contacts.addAccount"))}</button>
        </div>
        <div>
          <div class="section-title">${escapeHtml(t("contacts.contacts"))}</div>
          <div class="list" id="con-list">${contacts.length ? "" : `<div class="hint">${escapeHtml(t("contacts.noContacts"))}</div>`}</div>
          <button class="btn sm" id="add-con" style="margin-top:8px" ${accounts.length ? "" : "disabled"}>＋ ${escapeHtml(t("contacts.addContact"))}</button>
        </div>
      </div>`;
    const accList = body.querySelector("#acc-list");
    for (const a of accounts) {
      const row = document.createElement("div");
      row.className = "list-row";
      const sub = a.provider === "cli" ? `${a.cliKind}${a.cliPath ? " · " + a.cliPath : ""}` : `${a.baseURL}${a.hasKey ? " · ****" + a.keyHint : ""}`;
      row.innerHTML = `<div class="grow"><div class="title">${escapeHtml(a.name)} <span class="pill">${escapeHtml(a.provider)}</span>${a.enabled ? "" : ` <span class="pill off">off</span>`}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
      const edit = document.createElement("button"); edit.className = "btn sm"; edit.textContent = "✎";
      edit.addEventListener("click", () => openAccountForm(ctx, a, () => render(modal)));
      const rm = document.createElement("button"); rm.className = "btn sm danger"; rm.textContent = "✕";
      rm.addEventListener("click", async () => { if (!confirm(t("contacts.deleteAccount"))) return; await del(`/api/accounts/${a.id}`); await ctx.reload(); render(modal); });
      row.append(edit, rm);
      accList.appendChild(row);
    }
    const conList = body.querySelector("#con-list");
    for (const c of contacts) {
      const a = accounts.find((x) => x.id === c.accountId);
      const row = document.createElement("div");
      row.className = "list-row";
      row.appendChild(avatarEl(c, "sm"));
      const grow = document.createElement("div");
      grow.className = "grow";
      const sub = c.id === "deskdock" ? t("contacts.builtin") : `${a?.name ?? "?"} · ${c.model}`;
      grow.innerHTML = `<div class="title">${escapeHtml(c.nickname)}${c.enabled ? "" : ` <span class="pill off">off</span>`}</div><div class="sub">${escapeHtml(sub)}</div>`;
      row.appendChild(grow);
      const edit = document.createElement("button"); edit.className = "btn sm"; edit.textContent = "✎";
      edit.addEventListener("click", () => openContactForm(ctx, c, () => render(modal)));
      row.appendChild(edit);
      if (c.id !== "deskdock") {
        const clone = document.createElement("button"); clone.className = "btn sm"; clone.textContent = "⧉"; clone.title = t("contacts.cloneRole");
        clone.addEventListener("click", () => openContactForm(ctx, null, () => render(modal), { accountId: c.accountId, model: c.model, supportsTools: c.supportsTools, supportsVision: c.supportsVision, temperature: c.temperature, maxTokens: c.maxTokens }));
        row.appendChild(clone);
        const rm = document.createElement("button"); rm.className = "btn sm danger"; rm.textContent = "✕";
        rm.addEventListener("click", async () => { if (!confirm(t("contacts.deleteContact"))) return; await del(`/api/contacts/${c.id}`); await ctx.reload(); render(modal); });
        row.appendChild(rm);
      }
      conList.appendChild(row);
    }
    body.querySelector("#add-acc").addEventListener("click", () => openAccountForm(ctx, null, () => render(modal)));
    body.querySelector("#add-con").addEventListener("click", () => openContactForm(ctx, null, () => render(modal)));
  };
  openModal(ctx, { title: t("contacts.title"), bodyHtml: "", wide: true, buttons: [{ label: t("action.close") }], onOpen: render });
}

function openAccountForm(ctx, account, done) {
  const a = account ?? { provider: "openai", name: "", baseURL: DEFAULT_URLS.openai, cliKind: "claude", cliPath: "", enabled: true };
  const providers = ["openai", "anthropic", "ollama", "cli"];
  const html = `
    ${field(t("contacts.provider"), `<select id="f-provider" ${account ? "disabled" : ""}>${providers.map((p) => `<option value="${p}" ${a.provider === p ? "selected" : ""}>${escapeHtml(t("contacts.provider." + p))}</option>`).join("")}</select>`)}
    ${field(t("contacts.name"), `<input id="f-name" value="${escapeHtml(a.name)}" placeholder="DeepSeek">`)}
    <div id="f-api-fields">
      ${field(t("contacts.baseURL"), `<input id="f-url" value="${escapeHtml(a.baseURL)}">`)}
      ${field(t("contacts.key"), `<input id="f-key" type="password" placeholder="${account?.hasKey ? "****" + account.keyHint + " · " + escapeHtml(t("contacts.keyKeep")) : ""}" autocomplete="off">`, t("contacts.keyHint"))}
    </div>
    <div id="f-cli-fields">
      <div class="notice-box">${escapeHtml(t("contacts.cliWarn"))}</div>
      ${field(t("contacts.cliKind"), `<select id="f-clikind"><option value="claude" ${a.cliKind === "claude" ? "selected" : ""}>claude (Claude Code)</option><option value="codex" ${a.cliKind === "codex" ? "selected" : ""}>codex (Codex CLI)</option></select>`)}
      ${field(t("contacts.cliPath"), `<input id="f-clipath" value="${escapeHtml(a.cliPath ?? "")}">`)}
    </div>
    ${account ? `<label class="check"><input type="checkbox" id="f-enabled" ${a.enabled ? "checked" : ""}> enabled</label>` : ""}`;
  openModal(ctx, {
    title: account ? t("contacts.accounts") : t("contacts.addAccount"),
    bodyHtml: html,
    buttons: [
      { label: t("action.cancel") },
      {
        label: t("action.save"), primary: true,
        onClick: async (modal) => {
          const q = (id) => modal.querySelector(id);
          const provider = q("#f-provider").value;
          const body = { provider, name: q("#f-name").value.trim(), baseURL: q("#f-url").value.trim(), cliKind: q("#f-clikind").value, cliPath: q("#f-clipath").value.trim() };
          const key = q("#f-key").value;
          if (key) body.key = key;
          if (account) { body.enabled = q("#f-enabled").checked; await patch(`/api/accounts/${account.id}`, body); }
          else await post("/api/accounts", body);
          await ctx.reload();
          done();
        },
      },
    ],
    onOpen: (modal) => {
      const sel = modal.querySelector("#f-provider");
      const url = modal.querySelector("#f-url");
      const sync = () => {
        const p = sel.value;
        modal.querySelector("#f-api-fields").classList.toggle("hidden", p === "cli");
        modal.querySelector("#f-cli-fields").classList.toggle("hidden", p !== "cli");
        modal.querySelector("#f-key").closest(".field").classList.toggle("hidden", p === "ollama");
        if (!account && (!url.value || Object.values(DEFAULT_URLS).includes(url.value))) url.value = DEFAULT_URLS[p];
      };
      sel.addEventListener("change", sync);
      sync();
    },
  });
}

function openContactForm(ctx, contact, done, preset) {
  const accounts = ctx.accounts;
  const c = contact ?? { accountId: accounts[0]?.id ?? "", model: "", nickname: "", avatar: "", persona: "", supportsTools: true, supportsVision: false, temperature: undefined, maxTokens: undefined, enabled: true, ...(preset ?? {}) };
  const builtin = contact?.id === "deskdock";
  const html = builtin
    ? `${field(t("contacts.nickname"), `<input id="f-nick" value="${escapeHtml(c.nickname)}">`)}${field(t("contacts.avatar"), `<input id="f-avatar" value="${escapeHtml(c.avatar)}">`)}${field(t("contacts.persona"), `<textarea id="f-persona">${escapeHtml(c.persona)}</textarea>`)}<div class="hint">${escapeHtml(t("contacts.builtin"))}</div>`
    : `
    ${field(t("contacts.account"), `<select id="f-account">${accounts.map((a) => `<option value="${a.id}" ${a.id === c.accountId ? "selected" : ""}>${escapeHtml(a.name)} (${a.provider})</option>`).join("")}</select>`)}
    ${field(t("contacts.model"), `<div class="row"><input id="f-model" value="${escapeHtml(c.model)}" list="model-list" placeholder="deepseek-chat"><button class="btn sm" id="f-fetch" style="flex:0 0 auto">${escapeHtml(t("action.test"))}</button></div><datalist id="model-list"></datalist>`, t("contacts.modelHint"))}
    <div class="row">
      ${field(t("contacts.nickname"), `<input id="f-nick" value="${escapeHtml(c.nickname)}">`)}
      ${field(t("contacts.avatar"), `<input id="f-avatar" value="${escapeHtml(c.avatar)}" maxlength="2">`)}
    </div>
    ${field(t("contacts.persona"), `<textarea id="f-persona">${escapeHtml(c.persona)}</textarea>`, t("contacts.personaHint"))}
    <div class="row">
      ${field(t("contacts.temperature"), `<input id="f-temp" type="number" step="0.1" min="0" max="2" value="${c.temperature ?? ""}">`)}
      ${field(t("contacts.maxTokens"), `<input id="f-max" type="number" min="1" value="${c.maxTokens ?? ""}">`)}
    </div>
    <label class="check"><input type="checkbox" id="f-tools" ${c.supportsTools ? "checked" : ""}> ${escapeHtml(t("contacts.supportsTools"))}</label>
    <label class="check"><input type="checkbox" id="f-vision" ${c.supportsVision ? "checked" : ""}> ${escapeHtml(t("contacts.supportsVision"))}</label>
    ${contact ? `<label class="check"><input type="checkbox" id="f-enabled" ${c.enabled ? "checked" : ""}> enabled</label>` : ""}`;
  openModal(ctx, {
    title: contact ? t("contacts.contacts") : t("contacts.addContact"),
    bodyHtml: html,
    buttons: [
      { label: t("action.cancel") },
      {
        label: t("action.save"), primary: true,
        onClick: async (modal) => {
          const q = (id) => modal.querySelector(id);
          if (builtin) {
            await patch(`/api/contacts/deskdock`, { nickname: q("#f-nick").value.trim(), avatar: q("#f-avatar").value.trim(), persona: q("#f-persona").value });
          } else {
            const body = {
              accountId: q("#f-account").value,
              model: q("#f-model").value.trim(),
              nickname: q("#f-nick").value.trim(),
              avatar: q("#f-avatar").value.trim(),
              persona: q("#f-persona").value,
              supportsTools: q("#f-tools").checked,
              supportsVision: q("#f-vision").checked,
              temperature: q("#f-temp").value === "" ? null : Number(q("#f-temp").value),
              maxTokens: q("#f-max").value === "" ? null : Number(q("#f-max").value),
            };
            if (contact) { body.enabled = q("#f-enabled").checked; await patch(`/api/contacts/${contact.id}`, body); }
            else await post("/api/contacts", body);
          }
          await ctx.reload();
          done();
        },
      },
    ],
    onOpen: (modal) => {
      if (builtin) return;
      modal.querySelector("#f-fetch").addEventListener("click", async (e) => {
        e.preventDefault();
        const accId = modal.querySelector("#f-account").value;
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const models = await get(`/api/accounts/${accId}/models`);
          const dl = modal.querySelector("#model-list");
          dl.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name ?? m.id)}</option>`).join("");
          ctx.toast(`${models.length} models`);
          modal.querySelector("#f-model").focus();
        } catch (err) { ctx.toast(err.message, true); } finally { btn.disabled = false; }
      });
    },
  });
}

function drivers(ctx) {
  return ctx.contacts.filter((c) => c.enabled && c.id !== "deskdock" && c.supportsTools && ctx.accounts.find((a) => a.id === c.accountId)?.provider !== "cli");
}

export function openNewSession(ctx, onCreated) {
  const contacts = ctx.contacts.filter((c) => c.enabled);
  if (!contacts.length) { ctx.toast(t("new.noContacts"), true); return openContacts(ctx); }
  const html = `
    ${field(t("new.kind"), `<select id="n-kind"><option value="direct">${escapeHtml(t("new.direct"))}</option><option value="group">${escapeHtml(t("new.group"))}</option></select>`)}
    <div class="field"><label>${escapeHtml(t("new.pick"))}</label><div class="pick-list" id="n-pick">${contacts.map((c) => `<div class="pick-row" data-id="${c.id}"><span class="avatar sm ${c.id === "deskdock" ? "deskdock" : ""}">${escapeHtml((c.avatar || c.nickname).slice(0, 2))}</span><span class="grow">${escapeHtml(c.nickname)}</span><span class="hint">${escapeHtml(c.model)}</span></div>`).join("")}</div></div>
    <div id="n-driver-field" class="field hidden"><label>${escapeHtml(t("dd.driver"))}</label><select id="n-driver">${drivers(ctx).map((c) => `<option value="${c.id}">${escapeHtml(c.nickname)}</option>`).join("")}</select></div>
    <div id="n-roles" class="hidden" style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:12px">
      <div class="section-title" style="margin-top:0">${escapeHtml(t("roles.generate"))}</div>
      <div class="hint" style="margin-bottom:8px">${escapeHtml(t("roles.hint"))}</div>
      <div class="row">
        ${field(t("roles.base"), `<select id="n-base">${contacts.filter((c) => c.id !== "deskdock").map((c) => `<option value="${c.id}">${escapeHtml(c.nickname)} · ${escapeHtml(c.model)}</option>`).join("")}</select>`)}
        <div class="field"><label>&nbsp;</label><button class="btn" id="n-make-roles">${escapeHtml(t("roles.make"))}</button></div>
      </div>
    </div>
    <div id="n-group-fields" class="hidden">
      ${field(t("disc.template"), `<select id="n-template"><option value="">${escapeHtml(t("disc.templateNone"))}</option>${templates().map((tp) => `<option value="${tp.id}">${escapeHtml(tp.name)} · ${escapeHtml(tp.hint)}</option>`).join("")}</select>`, t("disc.applyHint"))}
      <div class="warn-text hidden" id="n-template-hint" style="margin:-6px 0 10px"></div>
      ${field(t("session.title"), `<input id="n-title" placeholder="">`)}
      ${field(t("session.intro"), `<textarea id="n-intro"></textarea>`, t("session.introHint"))}
      <div class="row">
        ${field(t("cost.perRound") + " ($)", `<input id="n-per-round" type="number" min="0" step="0.1">`)}
        ${field(t("cost.total") + " ($)", `<input id="n-total" type="number" min="0" step="0.1">`)}
      </div>
      <div class="hint">${escapeHtml(t("new.budgetHint"))}</div>
    </div>`;
  const picked = new Set();
  openModal(ctx, {
    title: t("new.title"),
    bodyHtml: html,
    buttons: [
      { label: t("action.cancel") },
      {
        label: t("action.create"), primary: true,
        onClick: async (modal) => {
          const q = (id) => modal.querySelector(id);
          const kind = q("#n-kind").value;
          const tp = templates().find((x) => x.id === q("#n-template").value);
          const driverId = q("#n-driver").value;
          let roleIndex = 0;
          const members = [...picked].map((contactId) => {
            const c = ctx.contacts.find((x) => x.id === contactId);
            const role = contactId === "deskdock" ? "" : (tp?.roles[roleIndex++] ?? "");
            // A generated role already carries the text as its persona; repeating it as a role card would double it.
            return { contactId, roleCard: c && c.persona === role ? "" : role, driverContactId: contactId === "deskdock" ? driverId : undefined };
          });
          if (!members.length) throw new Error(t("new.pick"));
          const body = { kind, members, title: q("#n-title").value.trim(), intro: q("#n-intro").value || (kind === "group" && tp ? tp.intro : ""), templateId: tp?.id };
          const perRound = Number(q("#n-per-round").value);
          const total = Number(q("#n-total").value);
          body.budget = {};
          if (perRound > 0) body.budget.perRound = perRound;
          if (total > 0) body.budget.total = total;
          const s = await post("/api/sessions", body);
          onCreated(s);
        },
      },
    ],
    onOpen: (modal) => {
      const kindSel = modal.querySelector("#n-kind");
      const pick = modal.querySelector("#n-pick");
      modal.querySelector("#n-template").addEventListener("change", (e) => {
        const tp = templates().find((x) => x.id === e.target.value);
        const intro = modal.querySelector("#n-intro");
        if (tp && !intro.value) intro.value = tp.intro;
        templateHint();
      });
      const sync = () => { modal.querySelector("#n-group-fields").classList.toggle("hidden", kindSel.value !== "group"); modal.querySelector("#n-roles").classList.toggle("hidden", kindSel.value !== "group"); };
      modal.querySelector("#n-make-roles").addEventListener("click", async (e) => {
        e.preventDefault();
        const tp = templates().find((x) => x.id === modal.querySelector("#n-template").value);
        if (!tp) { ctx.toast(t("disc.templateNone"), true); return; }
        const base = ctx.contacts.find((c) => c.id === modal.querySelector("#n-base").value);
        if (!base) return;
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const made = [];
          for (let i = 0; i < tp.roles.length; i++) {
            let nickname = tp.names?.[i] ?? `${base.nickname} ${i + 1}`;
            const sameRole = ctx.contacts.find((c) => c.nickname === nickname && c.accountId === base.accountId && c.model === base.model);
            // The same role name on a different model gets the base contact's name appended, so a group can hold both.
            if (!sameRole && ctx.contacts.some((c) => c.nickname === nickname)) nickname = `${nickname}（${base.nickname}）`;
            const existing = sameRole;
            const c = existing ?? await post("/api/contacts", { accountId: base.accountId, model: base.model, nickname, avatar: nickname.slice(0, 1), persona: tp.roles[i], supportsTools: base.supportsTools, supportsVision: base.supportsVision, temperature: base.temperature ?? null, maxTokens: base.maxTokens ?? null });
            made.push(c);
          }
          await ctx.reload();
          // Rebuild the pick list with the new contacts and select the roles in template order.
          const list = ctx.contacts.filter((c) => c.enabled);
          pick.innerHTML = list.map((c) => `<div class="pick-row" data-id="${c.id}"><span class="avatar sm ${c.id === "deskdock" ? "deskdock" : ""}">${escapeHtml((c.avatar || c.nickname).slice(0, 2))}</span><span class="grow">${escapeHtml(c.nickname)}</span><span class="hint">${escapeHtml(c.model)}</span></div>`).join("");
          const keep = [...picked].filter((id) => id === "deskdock");
          picked.clear();
          for (const id of keep) picked.add(id);
          for (const c of made) picked.add(c.id);
          const intro = modal.querySelector("#n-intro");
          if (!intro.value) intro.value = tp.intro;
          if (!modal.querySelector("#n-title").value) modal.querySelector("#n-title").value = tp.name;
          paint();
          ctx.toast(t("roles.made", { n: made.length }));
        } catch (err) { ctx.toast(err.message, true); } finally { btn.disabled = false; }
      });
      kindSel.addEventListener("change", () => { if (kindSel.value === "direct" && picked.size > 1) { const first = [...picked][0]; picked.clear(); picked.add(first); paint(); } sync(); });
      const templateHint = () => {
        const tp = templates().find((x) => x.id === modal.querySelector("#n-template").value);
        const hint = modal.querySelector("#n-template-hint");
        const humans = [...picked].filter((id) => id !== "deskdock").length;
        if (tp && humans !== tp.roles.length) { hint.textContent = t("disc.roleMismatch", { roles: tp.roles.length, members: humans }); hint.classList.remove("hidden"); }
        else hint.classList.add("hidden");
      };
      const paint = () => { for (const r of pick.querySelectorAll(".pick-row")) r.classList.toggle("on", picked.has(r.dataset.id)); modal.querySelector("#n-driver-field").classList.toggle("hidden", !picked.has("deskdock")); templateHint(); };
      pick.addEventListener("click", (e) => {
        const row = e.target.closest(".pick-row");
        if (!row) return;
        const id = row.dataset.id;
        if (picked.has(id)) picked.delete(id);
        else { if (kindSel.value === "direct") picked.clear(); picked.add(id); }
        paint();
      });
      sync();
    },
  });
}
