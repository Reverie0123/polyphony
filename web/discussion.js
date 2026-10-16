// Free discussion: the start dialog and the status bar under the chat header.
import { t } from "./i18n.js";
import { escapeHtml } from "./markdown.js";
import { post, patch } from "./api.js";
import { openModal } from "./modal.js";
import { formatCost } from "./chat.js";
import { templates } from "./templates.js";

export function openDiscussion(ctx, session) {
  const members = session.members.map((m) => ctx.contacts.find((c) => c.id === m.contactId)).filter((c) => c && c.id !== "deskdock");
  const lastUser = [...session.messages].reverse().find((m) => m.sender === "user" && m.text.trim());
  const providers = [...new Set(members.map((c) => ctx.accounts.find((a) => a.id === c.accountId)?.name ?? "?"))].join("、");
  const money = (usd) => (usd ? formatCost({ usd, cny: usd * ctx.settings.usdToCny, priced: true, kind: "metered" }, ctx.settings) : t("disc.noBudget"));
  const f = (label, input, hint) => `<div class="field"><label>${escapeHtml(label)}</label>${input}${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ""}</div>`;
  const opts = (sel) => `<option value="">${escapeHtml(t("disc.none"))}</option>` + members.map((c) => `<option value="${c.id}" ${sel === c.id ? "selected" : ""}>${escapeHtml(c.nickname)}</option>`).join("");
  const tp = templates().find((x) => x.id === session.templateId);
  const minRounds = tp?.minRounds ?? 1;
  const html = `
    ${minRounds > 1 ? `<div class="notice-box">${escapeHtml(t("disc.minRounds", { n: minRounds }))}</div>` : ""}
    ${f(t("disc.question"), `<textarea id="d-q">${escapeHtml(lastUser?.text ?? "")}</textarea>`, t("disc.questionHint"))}
    <div class="row">
      ${f(t("disc.rounds"), `<input id="d-rounds" type="number" min="${minRounds}" max="50" value="${Math.max(3, minRounds)}">`)}
      ${f(t("disc.summarizer"), `<select id="d-sum">${opts("")}</select>`)}
    </div>
    ${session.speakingOrder === "host" ? f(t("disc.host"), `<select id="d-host">${opts("")}</select>`) : ""}
    ${f(t("disc.canEnd"), `<div>${members.map((c) => `<label class="check"><input type="checkbox" data-canend="${c.id}" ${session.canEndDiscussion?.includes(c.id) ? "checked" : ""}> ${escapeHtml(c.nickname)}</label>`).join("")}</div>`)}
    <div class="notice-box">${escapeHtml(t("disc.budgetLine", { providers, perRound: money(session.budget?.perRound), gap: session.roundGapSec }))}</div>`;
  openModal(ctx, {
    title: t("disc.title"),
    bodyHtml: html,
    buttons: [
      { label: t("action.cancel") },
      {
        label: t("disc.start"), primary: true,
        onClick: async (modal) => {
          const q = (id) => modal.querySelector(id);
          const canEnd = [...modal.querySelectorAll("[data-canend]")].filter((x) => x.checked).map((x) => x.dataset.canend);
          await patch(`/api/sessions/${session.id}`, { canEndDiscussion: canEnd });
          const body = { question: q("#d-q").value.trim(), rounds: Math.max(minRounds, Number(q("#d-rounds").value) || 3), summarizerContactId: q("#d-sum").value || undefined, hostContactId: q("#d-host")?.value || undefined };
          const d = await post(`/api/sessions/${session.id}/discussion`, body);
          session.discussion = d;
          renderDiscBar(ctx, session);
        },
      },
    ],
  });
}

export function renderDiscBar(ctx, session) {
  const bar = document.getElementById("disc-bar");
  const d = session?.discussion;
  if (!d || (d.status !== "running" && d.status !== "paused")) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.classList.toggle("paused", d.status === "paused");
  const cost = formatCost({ usd: d.spent, cny: d.spent * ctx.settings.usdToCny, priced: true, kind: "metered" }, ctx.settings);
  const label = d.status === "paused" ? t("disc.paused", { r: d.currentRound, n: d.rounds }) : t("disc.running", { r: d.currentRound, n: d.rounds, cost });
  bar.innerHTML = `<span class="grow">${escapeHtml(label)} · ${escapeHtml(d.question.slice(0, 60))}</span>`;
  const act = (label, verb, primary) => {
    const b = document.createElement("button");
    b.className = "btn sm" + (primary ? " primary" : "");
    b.textContent = label;
    b.addEventListener("click", async () => {
      try { const r = await post(`/api/sessions/${session.id}/discussion/${verb}`); session.discussion = r.discussion; renderDiscBar(ctx, session); } catch (e) { ctx.toast(e.message, true); }
    });
    bar.appendChild(b);
  };
  if (d.status === "running") act(t("disc.pause"), "pause");
  else { act(t("disc.resume"), "resume", true); act(t("disc.drop"), "drop"); }
  act(t("disc.stop"), "stop");
}
