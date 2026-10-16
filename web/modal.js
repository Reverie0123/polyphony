// Generic modal dialog used by every form in the app.
import { escapeHtml } from "./markdown.js";

export function openModal(ctx, { title, bodyHtml, wide, buttons, onOpen }) {
  const root = document.getElementById("modal-root");
  const modal = document.createElement("div");
  modal.className = "modal" + (wide ? " wide" : "");
  modal.innerHTML = `<div class="modal-head"><span>${escapeHtml(title)}</span><button class="icon-btn" data-close>✕</button></div><div class="modal-body">${bodyHtml}</div><div class="modal-foot"></div>`;
  const foot = modal.querySelector(".modal-foot");
  let cleanup = () => {};
  const close = () => { cleanup(); modal.remove(); };
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
  const onKey = (e) => { if (e.key === "Escape" && root.lastElementChild === modal) { close(); } };
  document.addEventListener("keydown", onKey);
  const onOverlay = (e) => { if (e.target === root && root.lastElementChild === modal) close(); };
  root.addEventListener("click", onOverlay);
  cleanup = () => { document.removeEventListener("keydown", onKey); root.removeEventListener("click", onOverlay); };
  root.appendChild(modal);
  onOpen?.(modal, close);
  return { modal, close };
}
