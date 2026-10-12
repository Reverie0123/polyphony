// Picks the background helpers: the secretary (rolling summaries) and the vision contact (image captions).
// Rule from the design doc: Ollama first, then the cheapest priced API model; local CLI contacts never take part.
import type { Contact, Settings } from "./models.js";
import type { Store } from "./store.js";
import type { Pricing } from "./pricing.js";

function candidates(store: Store): Contact[] {
  return store.listContacts().filter((c) => {
    if (!c.enabled || !c.accountId || !c.model) return false;
    const a = store.getAccount(c.accountId);
    return !!a && a.enabled && a.provider !== "cli" && (a.provider === "ollama" || a.hasKey);
  });
}

function cheapest(store: Store, pricing: Pricing, list: Contact[]): Contact | undefined {
  const ollama = list.find((c) => store.getAccount(c.accountId)?.provider === "ollama");
  if (ollama) return ollama;
  let best: Contact | undefined;
  let bestPrice = Infinity;
  for (const c of list) {
    const a = store.getAccount(c.accountId)!;
    const p = pricing.lookup(a.provider, c.model);
    const score = p ? p.input + p.output : Infinity - 1; // unpriced models rank last but still count
    if (score < bestPrice) { bestPrice = score; best = c; }
  }
  return best ?? list[0];
}

export function pickSecretary(store: Store, pricing: Pricing, settings: Settings): Contact | undefined {
  if (settings.secretaryContactId !== "auto") {
    const c = store.getContact(settings.secretaryContactId);
    if (c && c.enabled) return c;
  }
  return cheapest(store, pricing, candidates(store));
}

/** Returns a vision-capable contact, or undefined when OCR should be used instead. */
export function pickVision(store: Store, pricing: Pricing, settings: Settings): Contact | undefined {
  if (settings.visionContactId === "ocr") return undefined;
  if (settings.visionContactId !== "auto") {
    const c = store.getContact(settings.visionContactId);
    if (c && c.enabled && c.supportsVision) return c;
  }
  return cheapest(store, pricing, candidates(store).filter((c) => c.supportsVision));
}
