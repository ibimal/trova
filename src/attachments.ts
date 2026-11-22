// Attachments become a sidecar markdown collection: each PDF, canvas, Office file or OCR'd image
// gets a markdown file named `<original path>.md` under ~/.cache/trova/attachments/<collection>/.
// qmd indexes that folder as the collection `<collection>-att`.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  EngineError,
  extname,
  inScope,
  MAX_TEXT_BYTES,
  type CollectionOptions,
} from "./contract/index.js";
import type { Sidecar } from "./sidecar.js";

export const DEFAULT_ATTACHMENTS = ["pdf", "canvas", "image"];
const TYPE_EXTS: Record<string, string[]> = {
  pdf: ["pdf"],
  canvas: ["canvas"],
  office: ["docx", "pptx", "xlsx"],
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
};
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash"]);

export function attachmentType(path: string): string | null {
  const ext = extname(path);
  for (const [type, exts] of Object.entries(TYPE_EXTS)) if (exts.includes(ext)) return type;
  return null;
}

function truncate(text: string): string {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
  return Buffer.from(text).subarray(0, MAX_TEXT_BYTES).toString("utf8");
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function xmlTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]!));
  return out;
}

export async function extractPdf(data: Uint8Array): Promise<string> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(src: Record<string, unknown>): {
      promise: Promise<PdfDoc>;
      destroy(): Promise<void>;
    };
  };
  interface PdfDoc {
    numPages: number;
    getPage(
      n: number,
    ): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>;
  }
  // The loading task owns the document; destroying the task releases both.
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages: string[] = [];
  let bytes = 0;
  try {
    for (let n = 1; n <= doc.numPages && bytes < MAX_TEXT_BYTES; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const text = content.items
        .map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " "))
        .join("")
        .replace(/[ \t]+/g, " ")
        .trim();
      if (!text) continue;
      pages.push(`## Page ${n}\n\n${text}`);
      bytes += text.length;
    }
  } finally {
    await task.destroy().catch(() => undefined);
  }
  return pages.join("\n\n");
}

export function extractCanvas(json: string): string {
  let data: {
    nodes?: { type?: string; text?: string; file?: string; url?: string; label?: string }[];
  };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return "";
  }
  const cards: string[] = [];
  const files: string[] = [];
  for (const node of data.nodes ?? []) {
    if (node.type === "text" && node.text) cards.push(node.text.trim());
    else if (node.type === "file" && node.file) files.push(node.file.split("/").pop()!);
    else if (node.type === "link" && node.url) cards.push(node.url);
    else if (node.type === "group" && node.label) cards.push(node.label);
  }
  const parts = [...cards];
  if (files.length) parts.push(`## Files\n\n${files.map((f) => `- ${f}`).join("\n")}`);
  return parts.join("\n\n");
}

export async function extractOffice(data: Uint8Array, ext: string): Promise<string> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(data, {
    filter: (f) =>
      /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/sharedStrings\.xml)$/.test(f.name),
  });
  if (ext === "docx") {
    const xml = files["word/document.xml"];
    if (!xml) return "";
    return xmlTexts(strFromU8(xml), "w:p")
      .map((p) => xmlTexts(p, "w:t").join(""))
      .filter((p) => p.trim())
      .join("\n\n");
  }
  if (ext === "pptx") {
    return Object.keys(files)
      .filter((n) => n.startsWith("ppt/slides/"))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
      .map(
        (name, i) => `## Slide ${i + 1}\n\n${xmlTexts(strFromU8(files[name]!), "a:t").join("\n")}`,
      )
      .join("\n\n");
  }
  const shared = files["xl/sharedStrings.xml"];
  return shared ? xmlTexts(strFromU8(shared), "t").join("\n") : "";
}

async function extract(file: string, ext: string): Promise<string> {
  if (ext === "canvas") return extractCanvas(readFileSync(file, "utf8"));
  const data = new Uint8Array(readFileSync(file));
  if (ext === "pdf") return extractPdf(data);
  return extractOffice(data, ext);
}

function walk(root: string, rel: string, out: string[]): void {
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (d.name.startsWith(".") || SKIP_DIRS.has(d.name)) continue;
    const child = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) walk(root, child, out);
    else if (d.isFile()) out.push(child);
  }
}

export function attachmentDir(attachmentsRoot: string, collection: string): string {
  return join(attachmentsRoot, collection);
}

/**
 * The text file for an attachment path. The path comes from the vault walk or from a request, so it
 * must be relative and stay inside the collection's folder; anything else is refused.
 */
function textFile(dir: string, path: string): string {
  const target = resolve(dir, `${path}.md`);
  const rel = relative(resolve(dir), target);
  if (!path || rel.startsWith("..") || resolve(rel) === rel)
    throw new EngineError("bad_request", `"${path}" is not a path inside the collection`);
  return target;
}

function writeText(dir: string, path: string, text: string): void {
  const target = textFile(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, truncate(text));
}

function removeText(dir: string, path: string): void {
  rmSync(textFile(dir, path), { force: true });
}

/** Stores OCR text that the plugin pushed for an image. An empty text removes the entry. */
export function storePushedText(
  sidecar: Sidecar,
  attachmentsRoot: string,
  collection: string,
  path: string,
  text: string,
): void {
  const dir = attachmentDir(attachmentsRoot, collection);
  if (!text.trim()) {
    removeText(dir, path);
    sidecar.removeAttachment(collection, path);
    return;
  }
  writeText(dir, path, text);
  sidecar.putAttachment(collection, path, Date.now(), text.length, true);
}

/**
 * Brings the sidecar markdown files in line with the collection's attachments. Returns true when
 * the attachment folder holds at least one file, so the `-att` collection is worth registering.
 */
export async function syncAttachments(
  sidecar: Sidecar,
  attachmentsRoot: string,
  collection: string,
  root: string,
  options: CollectionOptions,
  pause: () => Promise<void>,
): Promise<boolean> {
  const types = options.attachments ?? DEFAULT_ATTACHMENTS;
  const exts = new Set(types.filter((t) => t !== "image").flatMap((t) => TYPE_EXTS[t] ?? []));
  const dir = attachmentDir(attachmentsRoot, collection);
  mkdirSync(dir, { recursive: true });
  const manifest = sidecar.attachmentManifest(collection);
  const seen = new Set<string>();
  const files: string[] = [];
  if (exts.size > 0) walk(root, "", files);
  for (const rel of files) {
    const ext = extname(rel);
    if (!exts.has(ext) || !inScope(rel, options.include, options.exclude)) continue;
    seen.add(rel);
    const file = join(root, rel);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const known = manifest.get(rel);
    if (
      known &&
      !known.pushed &&
      known.mtime === Math.round(stat.mtimeMs) &&
      known.size === stat.size
    )
      continue;
    await pause();
    let text = "";
    try {
      text = await extract(file, ext);
    } catch {
      text = "";
    }
    if (text.trim()) writeText(dir, rel, text);
    else removeText(dir, rel);
    sidecar.putAttachment(collection, rel, stat.mtimeMs, stat.size, false);
  }
  for (const [path, info] of manifest) {
    // Pushed OCR text stays while its image exists; extracted text goes when its file goes or its type is switched off.
    const gone = info.pushed
      ? !existsSync(join(root, path)) || !types.includes("image")
      : !seen.has(path);
    if (gone) {
      removeText(dir, path);
      sidecar.removeAttachment(collection, path);
    }
  }
  return sidecar.attachmentManifest(collection).size > 0;
}
