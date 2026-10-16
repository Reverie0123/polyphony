// Image captions: a vision-capable contact describes the picture, or the Windows OCR engine extracts its text.
// Captions are cached by content hash so the same picture is never paid for twice.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Cost, Message, Session, Usage } from "./models.js";
import type { Store } from "./store.js";
import type { Pricing } from "./pricing.js";
import { Attachments, isImage } from "./attachments.js";
import { writeJsonAtomic } from "./store.js";
import { pickVision } from "./roles.js";
import type { CallContact } from "./engine.js";
import type { Broadcast } from "./engine.js";

export function ocrScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(here, "..", "resources", "ocr.ps1"), path.resolve(here, "..", "..", "resources", "ocr.ps1")]) if (existsSync(p)) return p;
  throw new Error("resources/ocr.ps1 not found");
}

/** Runs the one-shot OCR script. Windows only; resolves to the recognised text (possibly empty). */
export function ocrImage(file: string, timeoutMs = 30000): Promise<{ text: string; lang: string }> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new Error("OCR needs Windows"));
    // WinRT wants a native absolute path with backslashes.
    const b64 = Buffer.from(path.resolve(file), "utf8").toString("base64");
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ocrScriptPath(), "-PathB64", b64], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error("OCR timed out")); }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    p.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
      if (!line) return reject(new Error(err.trim() || "OCR produced no output"));
      try {
        const j = JSON.parse(line) as { ok: boolean; text?: string; lang?: string; error?: string };
        if (!j.ok) return reject(new Error(j.error ?? "OCR failed"));
        resolve({ text: j.text ?? "", lang: j.lang ?? "" });
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

interface CachedCaption { caption: string; by: string; usage?: Usage; cost?: Cost; at: string }

export interface VisionDeps {
  store: Store;
  pricing: Pricing;
  attachments: Attachments;
  broadcast: Broadcast;
  lang: () => "zh" | "en";
  call: CallContact;
  /** Test hook: replaces the OCR runner. */
  ocr?: (file: string) => Promise<{ text: string; lang: string }>;
}

export class Vision {
  private running = 0;
  constructor(private deps: VisionDeps) {}

  get busy(): number {
    return this.running;
  }

  private cacheFile(hash: string): string {
    return this.deps.store.file(path.join("cache", `vision-${hash}.json`));
  }

  /** Fills in captions for every image attachment of the message that lacks one. Resolves when all are done. */
  async describe(session: Session, message: Message): Promise<void> {
    const images = (message.attachments ?? []).filter((a) => isImage(a.mime) && !a.caption);
    if (!images.length) return;
    this.running++;
    try {
      for (const att of images) {
        try {
          await this.describeOne(session, message, att);
        } catch (err) {
          att.captionError = (err as Error).message;
        }
        this.deps.store.saveSession(session);
        this.deps.broadcast("message.updated", { sessionId: session.id, message });
      }
    } finally {
      this.running--;
    }
  }

  private async describeOne(session: Session, message: Message, att: Message["attachments"][number]): Promise<void> {
    const { store, pricing, attachments } = this.deps;
    const cf = this.cacheFile(att.hash);
    if (existsSync(cf)) {
      try {
        const c = JSON.parse(readFileSync(cf, "utf8")) as CachedCaption;
        att.caption = c.caption;
        att.captionBy = c.by;
        att.captionCost = { usd: 0, cny: 0, priced: true, kind: "free" };
        return;
      } catch { /* fall through */ }
    }
    const lang = this.deps.lang();
    const settings = store.getSettings();
    const contact = pickVision(store, pricing, settings);
    const file = attachments.read(att.hash);
    if (!file) throw new Error("attachment file missing");
    let result: CachedCaption;
    if (contact) {
      const prompt = lang === "zh"
        ? "请用中文描述这张图片的内容，先概括，再逐条列出图中所有可见文字（原样抄录）。不要加评论。"
        : "Describe this image: a short overview, then every piece of visible text transcribed verbatim. No commentary.";
      const r = await this.deps.call(contact, {
        model: contact.model,
        system: lang === "zh" ? "你是看图员，只负责把图片内容转成文字。" : "You convert images into text; nothing else.",
        messages: [{ role: "user", content: prompt }],
        images: [{ mime: att.mime, data: file.bytes.toString("base64") }],
        maxTokens: 1200,
      }, { purpose: "vision", sessionId: session.id, messageId: message.id, timeoutMs: 90000 });
      result = { caption: r.text.trim(), by: contact.nickname, usage: r.usage, cost: r.cost, at: new Date().toISOString() };
    } else {
      const ocr = await (this.deps.ocr ?? ocrImage)(file.file);
      // The Windows engine puts a space between every CJK character; collapse those.
      const text = ocr.text.trim().replace(/(?<=[　-鿿＀-￯])\s+(?=[　-鿿＀-￯])/g, "");
      result = {
        caption: text ? (lang === "zh" ? `OCR 识别文字：\n${text}` : `OCR text:\n${text}`) : (lang === "zh" ? "（OCR 没有识别到文字）" : "(OCR found no text)"),
        by: "ocr",
        at: new Date().toISOString(),
      };
    }
    att.caption = result.caption;
    att.captionBy = result.by;
    att.captionCost = result.cost ?? { usd: 0, cny: 0, priced: true, kind: "free" };
    writeJsonAtomic(cf, result);
  }
}
