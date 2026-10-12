// Generic modal dialog used by every form in the app.
import { escapeHtml } from "./markdown.js";

export function openModal(ctx, { title, bodyHtml, wide, buttons, onOpen }) {
  const root = document.getElementById("modal-root");
  const modal = document.createElement("div");
  modal.className = "modal" + (wide ? " wide" : "");
  modal.innerHTML = `<div class="modal-head"><span>${escapeHtml(title)}</span><button class="icon-btn" data-close>✕</button></div><div class="modal-body">${bodyHtml}</div><div class="modal-foot"></div>`;
  const foot = modal.querySelector(".modal-foot");
  const close = () => { modal.remove(); };
  for (const b of buttons ?? []) {
    const el = document.createElement("button");
    el.className = "btn " + (b.primary ? "primary" : b.danger ? "danger" : "");
    el.textContent = b.label;
    el.addEventListener("click", async () => {
      el.disabled = true;
      try { const keep = await b.onClick?.(modal, close); if (keep !== true) close(); } catch (err) { ctx.toast(err.message, true); } finally { el.disabled = false; }
    });
    foot.appendChild(el);
  }
  modal.querySelector("[data-close]").addEventListener("click", close);
  root.appendChild(modal);
  onOpen?.(modal, close);
  return { modal, close };
}
