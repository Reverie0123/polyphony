// Attachment storage: files are kept once under attachments/<sha256>.<ext>; text files carry their content as the caption
// so the context builder can inline them; images get a caption from the vision step later.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Attachment } from "./models.js";

export const MAX_TEXT_CHARS = 20000;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json",
};

const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "json", "js", "mjs", "ts", "tsx", "jsx", "py", "c", "cpp", "h", "hpp", "java", "go", "rs", "rb", "php", "cs", "html", "css", "xml", "yaml", "yml", "toml", "ini", "sh", "ps1", "bat", "sql", "log", "tex", "r", "kt", "swift", "lua"]);

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isTextFile(name: string, mime: string): boolean {
  if (mime.startsWith("text/") || mime === "application/json") return true;
  const ext = path.extname(name).slice(1).toLowerCase();
  return TEXT_EXT.has(ext);
}

export function sniffMime(name: string, declared: string, bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = path.extname(name).slice(1).toLowerCase();
  if (TEXT_EXT.has(ext)) return ext === "md" ? "text/markdown" : ext === "json" ? "application/json" : ext === "csv" ? "text/csv" : "text/plain";
  return "application/octet-stream";
}

export class Attachments {
  readonly dir: string;
  private index: Record<string, Attachment> = {};

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "attachments");
    mkdirSync(this.dir, { recursive: true });
    const idx = path.join(this.dir, "index.json");
    if (existsSync(idx)) { try { this.index = JSON.parse(readFileSync(idx, "utf8")) as Record<string, Attachment>; } catch { this.index = {}; } }
  }

  /** The record saved at upload time, so messages only need to reference the hash. */
  get(hash: string): Attachment | undefined {
    const a = this.index[hash];
    return a ? { ...a } : undefined;
  }

  /** Stores the bytes (deduplicated by content hash) and returns the attachment record. */
  save(name: string, declaredMime: string, bytes: Buffer): Attachment {
    if (bytes.length > MAX_FILE_BYTES) throw new Error("file too large");
    const mime = sniffMime(name, declaredMime, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const ext = EXT_BY_MIME[mime] ?? path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) ?? "bin";
    const file = path.join(this.dir, `${hash}.${ext || "bin"}`);
    if (!existsSync(file)) writeFileSync(file, bytes);
    const att: Attachment = { hash, name: path.basename(name).slice(0, 120), mime, size: bytes.length };
    if (!isImage(mime) && isTextFile(name, mime)) {
      const text = bytes.toString("utf8");
      att.caption = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "\n…[truncated]" : text;
    }
    this.index[hash] = att;
    const tmp = path.join(this.dir, "index.json.tmp");
    writeFileSync(tmp, JSON.stringify(this.index), "utf8");
    renameSync(tmp, path.join(this.dir, "index.json"));
    return att;
  }

  mimeOf(hash: string): string {
    return this.index[hash]?.mime ?? "application/octet-stream";
  }

  pathOf(hash: string): string | undefined {
    if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
    const prefix = path.join(this.dir, hash);
    for (const ext of [...new Set([...Object.values(EXT_BY_MIME), "bin"])]) {
      const p = `${prefix}.${ext}`;
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  read(hash: string): { bytes: Buffer; file: string } | undefined {
    const file = this.pathOf(hash);
    if (!file) return undefined;
    return { bytes: readFileSync(file), file };
  }
}

/** Text a model should see for a message: its text plus inlined file contents and image captions. */
export function attachmentText(att: Attachment, lang: "zh" | "en"): string {
  if (isImage(att.mime)) {
    if (!att.caption) return lang === "zh" ? `[图片 ${att.name}：尚未识别]` : `[image ${att.name}: not described yet]`;
    return lang === "zh" ? `[图片 ${att.name}]\n${att.caption}` : `[image ${att.name}]\n${att.caption}`;
  }
  if (att.caption) return lang === "zh" ? `[文件 ${att.name}]\n${att.caption}` : `[file ${att.name}]\n${att.caption}`;
  return lang === "zh" ? `[附件 ${att.name}，${att.size} 字节，内容未读取]` : `[attachment ${att.name}, ${att.size} bytes, not read]`;
}
