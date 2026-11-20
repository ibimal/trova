// The qmd adapter. Everything the engine needs from qmd goes through this class, so the rest of
// the engine never imports qmd. Tests inject an Embedder and DeepModels so no model is downloaded.

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore, type QMDStore } from "@tobilu/qmd";
import type { Lane, ModelState } from "@trova/contract";

export interface Embedder {
  id: string;
  dims: number;
  embed(text: string, isQuery: boolean): Promise<Float32Array>;
}

export interface DeepModels {
  expand(query: string): Promise<{ type: Lane; query: string }[]>;
  rerank(query: string, docs: { id: string; text: string }[]): Promise<Map<string, number>>;
}

export interface BackendOptions {
  dbPath: string;
  embedder?: Embedder;
  deep?: DeepModels;
  /** Embedding model URI; empty uses qmd's default. */
  embedModel?: string;
}

interface LlmModule {
  formatQueryForEmbedding(query: string, modelUri?: string): string;
  formatDocForEmbedding(text: string, title?: string, modelUri?: string): string;
  pullModels(models: string[], options?: { refresh?: boolean }): Promise<unknown>;
  DEFAULT_MODEL_CACHE_DIR: string;
}

const require = createRequire(import.meta.url);

/** qmd's dist folder. Its export map has no "require" condition, so the entry is resolved as an ES module. */
export function qmdDist(): string {
  try {
    const url = import.meta.resolve("@tobilu/qmd");
    if (url.startsWith("file:")) return dirname(fileURLToPath(url));
  } catch {
    /* the test runner has no import.meta.resolve; find the package by walking up instead */
  }
  for (const start of [import.meta.dirname, process.cwd()]) {
    let dir = start;
    for (;;) {
      const candidate = join(dir, "node_modules", "@tobilu", "qmd", "dist");
      if (existsSync(join(candidate, "index.js"))) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Cannot find the @tobilu/qmd package");
}

/** How often a running embedding run checks whether its job was paused or cancelled. */
const STOP_POLL_MS = 200;

/** Approximate download sizes, used to turn bytes on disk into a progress figure. */
const EMBED_MODEL_BYTES = 330e6;
const DEEP_MODEL_BYTES = 1.7e9;

export function modelIdFromUri(uri: string): string {
  const file = uri.split("/").pop() ?? uri;
  return file.replace(/\.gguf$/i, "").replace(/[-_.](q\d[\w]*|f16|f32)$/i, "");
}

export const CHUNK_CHARS = 3600;
export const CHUNK_OVERLAP = Math.floor(CHUNK_CHARS * 0.15);

/** Chunking used only with an injected embedder: about 900 tokens with 15% overlap, cut at a paragraph or line break. */
export function chunkText(text: string): { pos: number; text: string }[] {
  const out: { pos: number; text: string }[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(text.length, pos + CHUNK_CHARS);
    if (end < text.length) {
      const para = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      if (para > pos + CHUNK_CHARS / 2) end = para;
      else if (line > pos + CHUNK_CHARS / 2) end = line;
    }
    out.push({ pos, text: text.slice(pos, end) });
    if (end >= text.length) break;
    pos = Math.max(pos + 1, end - CHUNK_OVERLAP);
  }
  return out;
}

export class QmdBackend {
  private store!: QMDStore;
  private llm: LlmModule | null = null;
  private downloading = new Set<"embed" | "deep">();
  readonly version: string;

  private constructor(private opts: BackendOptions) {
    try {
      const pkgPath = join(qmdDist(), "..", "package.json");
      this.version = (require(pkgPath) as { version: string }).version;
    } catch {
      this.version = "unknown";
    }
  }

  static async open(opts: BackendOptions): Promise<QmdBackend> {
    const backend = new QmdBackend(opts);
    if (opts.embedModel) process.env.QMD_EMBED_MODEL = opts.embedModel;
    backend.store = await createStore({ dbPath: opts.dbPath });
    return backend;
  }

  get name(): string {
    return `qmd ${this.version}`;
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private async llmModule(): Promise<LlmModule> {
    if (!this.llm) {
      // llm.js is not in qmd's export map, so it is loaded by file path next to the entry point.
      const file = join(qmdDist(), "llm.js");
      this.llm = (await import(pathToFileURL(file).href)) as LlmModule;
    }
    return this.llm;
  }

  // ---------- collections ----------

  async listCollections(): Promise<{ name: string; path: string }[]> {
    return (await this.store.listCollections()).map((c) => ({ name: c.name, path: c.pwd }));
  }

  async addCollection(name: string, path: string, ignore: string[] = []): Promise<void> {
    await this.store.addCollection(name, { path, pattern: "**/*.md", ignore });
  }

  async removeCollection(name: string): Promise<boolean> {
    return this.store.removeCollection(name);
  }

  async renameCollection(from: string, to: string): Promise<boolean> {
    return this.store.renameCollection(from, to);
  }

  async setContexts(collection: string, context: Record<string, string>): Promise<void> {
    const existing = (await this.store.listContexts()).filter((c) => c.collection === collection);
    for (const c of existing) await this.store.removeContext(collection, c.path);
    for (const [path, text] of Object.entries(context)) {
      if (text.trim()) await this.store.addContext(collection, path || "/", text.trim());
    }
  }

  async addContext(collection: string, path: string, text: string): Promise<boolean> {
    return this.store.addContext(collection, path, text);
  }

  async removeContext(collection: string, path: string): Promise<boolean> {
    return this.store.removeContext(collection, path);
  }

  async listContexts(): Promise<{ collection: string; path: string; context: string }[]> {
    return this.store.listContexts();
  }

  // ---------- indexing ----------

  async update(collections: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    if (collections.length === 0) return;
    await this.store.update({ collections, onProgress: (p) => onProgress?.(p.current, p.total) });
  }

  /**
   * Embeds every document that has no vectors yet. Returns the number of chunks embedded. When
   * `shouldStop` turns true (the job was paused or cancelled) the run stops: the vectors written so
   * far are kept, and the remaining documents stay pending.
   */
  async embedPending(onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean): Promise<number> {
    const embedder = this.opts.embedder;
    if (!embedder) {
      const controller = new AbortController();
      const poll = shouldStop ? setInterval(() => shouldStop() && controller.abort(), STOP_POLL_MS) : null;
      let embedded = 0;
      const run = (force: boolean) =>
        this.store.embed({
          force,
          signal: controller.signal,
          onProgress: (p) => {
            embedded = p.chunksEmbedded;
            onProgress?.(p.chunksEmbedded, p.totalChunks);
          },
        });
      this.downloading.add("embed");
      try {
        const result = await run(false).catch((err: Error) => {
          // Vectors from a model with other dimensions: replace them all.
          if (!controller.signal.aborted && /dimension mismatch/i.test(err.message)) return run(true);
          throw err;
        });
        return result.chunksEmbedded;
      } catch (err) {
        if (controller.signal.aborted) return embedded;
        throw err;
      } finally {
        if (poll) clearInterval(poll);
        this.downloading.delete("embed");
      }
    }
    const internal = this.store.internal;
    const rows = internal.db
      .prepare(
        `SELECT d.hash AS hash, c.doc AS body FROM documents d JOIN content c ON c.hash = d.hash
         WHERE d.active = 1 AND NOT EXISTS (SELECT 1 FROM content_vectors cv WHERE cv.hash = d.hash) GROUP BY d.hash`,
      )
      .all<{ hash: string; body: string }>();
    if (rows.length === 0) return 0;
    internal.ensureVecTable(embedder.dims);
    let done = 0;
    let chunks = 0;
    for (const row of rows) {
      if (shouldStop?.()) break;
      const parts = chunkText(row.body);
      for (let seq = 0; seq < parts.length; seq++) {
        const vec = await embedder.embed(parts[seq]!.text, false);
        internal.insertEmbedding(row.hash, seq, parts[seq]!.pos, vec, embedder.id, new Date().toISOString(), parts.length, "");
        chunks++;
      }
      onProgress?.(++done, rows.length);
    }
    return chunks;
  }

  /** Documents waiting to be embedded. qmd's own count is per its model, so an injected embedder counts its own. */
  async pendingEmbeddings(): Promise<number> {
    if (this.opts.embedder) {
      const row = this.store.internal.db
        .prepare(
          `SELECT COUNT(DISTINCT d.hash) AS n FROM documents d WHERE d.active = 1 AND NOT EXISTS (SELECT 1 FROM content_vectors cv WHERE cv.hash = d.hash)`,
        )
        .get<{ n: number }>();
      return row?.n ?? 0;
    }
    return (await this.store.getStatus()).needsEmbedding;
  }

  // ---------- models ----------

  embedModelUri(): string {
    return this.opts.embedder?.id ?? this.store.internal.llm?.embedModelName ?? "";
  }

  embedModelId(): string {
    return this.opts.embedder ? this.opts.embedder.id : modelIdFromUri(this.embedModelUri());
  }

  private cachedBytes(uri: string): number {
    if (!uri) return 0;
    if (!uri.startsWith("hf:")) return existsSync(uri) ? statSync(uri).size : 0;
    const file = uri.split("/").pop()!;
    const dir = this.llm?.DEFAULT_MODEL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "", ".cache"), "qmd", "models");
    try {
      return readdirSync(dir)
        .filter((name) => name.includes(file) && !name.endsWith(".etag"))
        .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    } catch {
      return 0;
    }
  }

  private fileState(uri: string, kind: "embed" | "deep", expected: number): { state: ModelState; progress?: number } {
    const bytes = this.cachedBytes(uri);
    if (this.downloading.has(kind) && bytes < expected * 0.9) {
      return { state: "downloading", progress: Math.min(0.99, bytes / expected) };
    }
    return { state: bytes > 0 ? "ready" : "missing" };
  }

  modelStates(): {
    embed: { id?: string; state: ModelState; progress?: number };
    rerank: { id?: string; state: ModelState; progress?: number };
    expand: { id?: string; state: ModelState; progress?: number };
  } {
    if (this.opts.embedder) {
      const deep: ModelState = this.opts.deep ? "ready" : "missing";
      return { embed: { id: this.opts.embedder.id, state: "ready" }, rerank: { state: deep }, expand: { state: deep } };
    }
    const llm = this.store.internal.llm;
    const rerankUri = llm?.rerankModelName ?? "";
    const expandUri = llm?.generateModelName ?? "";
    return {
      embed: { id: this.embedModelId(), ...this.fileState(this.embedModelUri(), "embed", EMBED_MODEL_BYTES) },
      rerank: { id: modelIdFromUri(rerankUri), ...this.fileState(rerankUri, "deep", DEEP_MODEL_BYTES / 3) },
      expand: { id: modelIdFromUri(expandUri), ...this.fileState(expandUri, "deep", (DEEP_MODEL_BYTES * 2) / 3) },
    };
  }

  deepReady(): boolean {
    const m = this.modelStates();
    return m.rerank.state === "ready" && m.expand.state === "ready";
  }

  /** Downloads the rerank and expansion models (about 1.7 GB). Called only after the user confirms. */
  async downloadDeepModels(): Promise<void> {
    if (this.opts.embedder) return;
    const llm = this.store.internal.llm;
    if (!llm) return;
    const mod = await this.llmModule();
    this.downloading.add("deep");
    try {
      await mod.pullModels([llm.rerankModelName, llm.generateModelName]);
    } finally {
      this.downloading.delete("deep");
    }
  }

  // ---------- model calls ----------

  async embedText(text: string, isQuery: boolean): Promise<Float32Array | null> {
    if (this.opts.embedder) return this.opts.embedder.embed(text, isQuery);
    const llm = this.store.internal.llm;
    if (!llm) return null;
    const mod = await this.llmModule();
    const uri = llm.embedModelName;
    const formatted = isQuery ? mod.formatQueryForEmbedding(text, uri) : mod.formatDocForEmbedding(text, undefined, uri);
    const result = await llm.embed(formatted, { model: uri, isQuery });
    return result ? new Float32Array(result.embedding) : null;
  }

  async expand(query: string): Promise<{ type: Lane; query: string }[]> {
    if (this.opts.embedder) return this.opts.deep ? this.opts.deep.expand(query) : [];
    return (await this.store.expandQuery(query)).map((q) => ({ type: q.type, query: q.query }));
  }

  async rerank(query: string, docs: { id: string; text: string }[]): Promise<Map<string, number>> {
    if (this.opts.embedder) return this.opts.deep ? this.opts.deep.rerank(query, docs) : new Map();
    const scored = await this.store.internal.rerank(
      query,
      docs.map((d) => ({ file: d.id, text: d.text })),
    );
    return new Map(scored.map((s) => [s.file, s.score]));
  }

  /** Touches the models so qmd does not unload them while Obsidian is focused. */
  async keepWarm(): Promise<void> {
    if (this.opts.embedder) return;
    if (this.modelStates().embed.state === "ready") await this.embedText("warm", true).catch(() => null);
  }
}
