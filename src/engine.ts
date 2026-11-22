// The engine core. The HTTP server, the CLI and the MCP server all call this class, so every
// client sees the same index and the same ranking.

import { rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import {
  API_VERSION,
  ASK_DEEP_DEADLINE_MS,
  ASK_FAST_LIMIT,
  ASK_LANE_LIMIT,
  ASK_RELAX_BELOW,
  ASK_RERANK_TOP,
  ASK_STOPWORDS,
  EngineError,
  RELATED_NEAREST_CHUNKS,
  TYPO_RESCUE_MAX_RESULTS,
  blendRerank,
  blockAt,
  blockId,
  blockText,
  cosine,
  extname,
  findBlock,
  frontmatterEnd,
  labelForCosine,
  labelForRank,
  makeSnippet,
  matchesFilters,
  matchesTerms,
  meanVector,
  parseId,
  parseQuery,
  pickAskMode,
  queryRanges,
  queryText,
  replaceWord,
  rrf,
  sourceId,
  sourceScore,
  suggestCorrections,
  thresholdsFor,
  typoMaxEdits,
  type AskRequest,
  type AttachmentTextRequest,
  type Block,
  type Capability,
  type CollectionAddRequest,
  type CollectionInfo,
  type Correction,
  type DocumentBody,
  type DuplicatesResponse,
  type EngineAnchor,
  type EngineEvent,
  type Filter,
  type GetRequest,
  type IndexStatus,
  type Lane,
  type MatchedBy,
  type MetadataKeysResponse,
  type MultiGetRequest,
  type MultiGetResponse,
  type ParsedQuery,
  type RelatedRequest,
  type RelatedResponse,
  type Result,
  type ResultBatch,
  type ScoreRequest,
  type ScoreResponse,
  type Scores,
  type SearchRequest,
  type SyncRequest,
  type SyncResponse,
  type TopicsResponse,
  type VocabEntry,
  type VocabSuggestRequest,
  type VocabSuggestResponse,
  type GraphEdge,
  type GraphNode,
  type GraphRequest,
  type GraphResponse,
} from "./contract/index.js";
import { findDuplicates, findTopics } from "./analysis.js";

/** How many edges to other related sources one source keeps in the similarity graph. */
const GRAPH_EDGES_PER_NODE = 3;
import { attachmentDir, attachmentType, storePushedText, syncAttachments } from "./attachments.js";
import { QmdBackend, type DeepModels, type Embedder } from "./backend.js";
import { Jobs, type JobCtx } from "./jobs.js";
import { ENGINE_NAME, ENGINE_VERSION, dataPaths, type DataPaths } from "./paths.js";
import { QmdReader, buildFtsQuery } from "./reader.js";
import { ATT_SUFFIX, Sidecar, buildMeta, publicPath, splitBlocks, type MetaEntry } from "./sidecar.js";

/** Orders strings by their UTF-16 code units, as the default sort does, but states it. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface EngineOptions {
  home?: string;
  embedder?: Embedder;
  deep?: DeepModels;
  embedModel?: string;
  /** Watch collection folders and re-index on change. `trova watch` sets it. */
  watch?: boolean;
  watchDebounceMs?: number;
}

interface Hit {
  collection: string;
  entry: MetaEntry;
  /** Offset in the source text that the hit points at: a chunk start for vector hits. */
  pos?: number;
  scores: Scores;
  matchedBy: MatchedBy[];
}

interface AnchorVector {
  vector: Float32Array;
  collection?: string;
  entry?: MetaEntry;
  text?: string;
}

const STOPWORDS = new Set(
  "about after again also because been before being between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your".split(
    " ",
  ),
);

function keywords(text: string, max = 60): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    if (!STOPWORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  if (!Number.isFinite(ms)) return promise;
  if (ms <= 0) return Promise.resolve("timeout");
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError("cancelled", "The client aborted the request");
}

export class Engine {
  readonly paths: DataPaths;
  readonly jobs: Jobs;
  private listeners = new Set<(e: EngineEvent) => void>();
  private attRegistered = new Set<string>();
  private vocabCache: VocabEntry[] | null = null;
  private contextCache: Map<string, { path: string; context: string }[]> | null = null;
  private watchers = new Map<string, FSWatcher>();
  private watchTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private duplicates: DuplicatesResponse = { state: "none", pairs: [] };
  private topics: TopicsResponse = { state: "none", clusters: [] };
  /** Last time a client was seen. The daemon uses it for its idle exit. */
  lastActivity = Date.now();

  private constructor(
    private opts: EngineOptions,
    private backend: QmdBackend,
    private reader: QmdReader,
    private sidecar: Sidecar,
    paths: DataPaths,
  ) {
    this.paths = paths;
    this.jobs = new Jobs(sidecar, (e) => this.emit(e));
    this.duplicates = sidecar.getValue<DuplicatesResponse>("duplicates") ?? this.duplicates;
    this.topics = sidecar.getValue<TopicsResponse>("topics") ?? this.topics;
    if (this.duplicates.state === "running") this.duplicates.state = "none";
    if (this.topics.state === "running") this.topics.state = "none";
  }

  static async open(opts: EngineOptions = {}): Promise<Engine> {
    const paths = dataPaths(opts.home);
    const backend = await QmdBackend.open({ dbPath: paths.qmdDb, embedder: opts.embedder, deep: opts.deep, embedModel: opts.embedModel });
    const reader = new QmdReader(paths.qmdDb);
    const problems = reader.schemaProblems();
    if (problems.length > 0) {
      reader.close();
      await backend.close();
      throw new Error(
        `The index at ${paths.qmdDb} does not have the layout this trova build reads with ${backend.name}: ${problems.join("; ")}. ` +
          "Reinstall trova's dependencies (npm install) so its qmd version matches, then start it again.",
      );
    }
    const sidecar = new Sidecar(paths.sidecarDb);
    const engine = new Engine(opts, backend, reader, sidecar, paths);
    const known = new Set((await backend.listCollections()).map((c) => c.name));
    for (const name of sidecar.collectionNames()) {
      if (known.has(name + ATT_SUFFIX)) engine.attRegistered.add(name);
      if (opts.watch) engine.startWatcher(name);
    }
    return engine;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    for (const t of this.watchTimers.values()) clearTimeout(t);
    for (const j of this.jobs.active()) this.jobs.cancel(j.jobId);
    this.reader.close();
    this.sidecar.close();
    await this.backend.close();
  }

  // ---------- events ----------

  on(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a failing listener must not stop the engine */
      }
    }
  }

  // ---------- collections ----------

  private collectionsFor(requested?: string[]): string[] {
    const all = this.sidecar.collectionNames();
    if (!requested || requested.length === 0) return all;
    return requested.filter((n) => all.includes(n));
  }

  private qmdNames(collections: string[]): string[] {
    return collections.flatMap((n) => (this.attRegistered.has(n) ? [n, n + ATT_SUFFIX] : [n]));
  }

  private publicCollection(qmdCollection: string): string {
    return qmdCollection.endsWith(ATT_SUFFIX) && this.attRegistered.has(qmdCollection.slice(0, -ATT_SUFFIX.length))
      ? qmdCollection.slice(0, -ATT_SUFFIX.length)
      : qmdCollection;
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const contexts = await this.backend.listContexts();
    return this.sidecar.collectionNames().map((name) => {
      const c = this.sidecar.collection(name)!;
      const context: Record<string, string> = {};
      for (const ctx of contexts) if (ctx.collection === name) context[ctx.path] = ctx.context;
      return { name, path: c.path, options: c.options, context };
    });
  }

  async addCollection(req: CollectionAddRequest): Promise<CollectionInfo> {
    if (!req.name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(req.name) || req.name.endsWith(ATT_SUFFIX)) {
      throw new EngineError("bad_request", `"${req.name}" is not a valid collection name`);
    }
    const existing = this.sidecar.collection(req.name);
    const path = req.path ?? existing?.path;
    if (!path) throw new EngineError("bad_request", "A collection needs a path");
    try {
      if (!statSync(path).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new EngineError("bad_request", `"${path}" is not a folder`);
    }
    if (!existing || existing.path !== path) await this.backend.addCollection(req.name, path);
    this.sidecar.saveCollection(req.name, path, req.options ?? existing?.options ?? {});
    if (req.context) {
      await this.backend.setContexts(req.name, req.context);
      this.contextCache = null;
    }
    if (this.opts.watch) this.startWatcher(req.name);
    return (await this.listCollections()).find((c) => c.name === req.name)!;
  }

  async removeCollection(name: string): Promise<void> {
    if (!this.sidecar.collection(name)) throw new EngineError("not_found", `Unknown collection "${name}"`);
    this.watchers.get(name)?.close();
    this.watchers.delete(name);
    await this.backend.removeCollection(name);
    // The attachment collection may have been registered by an earlier daemon, so remove it whether or not this one did.
    this.attRegistered.delete(name);
    await this.backend.removeCollection(name + ATT_SUFFIX);
    rmSync(attachmentDir(this.paths.attachments, name), { recursive: true, force: true });
    this.sidecar.removeCollection(name);
    this.vocabCache = null;
    this.contextCache = null;
  }

  async renameCollection(from: string, to: string): Promise<void> {
    const c = this.sidecar.collection(from);
    if (!c) throw new EngineError("not_found", `Unknown collection "${from}"`);
    await this.removeCollection(from);
    await this.addCollection({ name: to, path: c.path, options: c.options });
    this.sync({ collection: to, full: true });
  }

  async setContext(collection: string, path: string, text: string | null): Promise<void> {
    if (!this.sidecar.collection(collection)) throw new EngineError("not_found", `Unknown collection "${collection}"`);
    if (text) await this.backend.addContext(collection, path, text);
    else await this.backend.removeContext(collection, path);
    this.contextCache = null;
  }

  private async contextFor(collection: string, path: string): Promise<string | undefined> {
    if (!this.contextCache) {
      this.contextCache = new Map();
      for (const c of await this.backend.listContexts()) {
        const list = this.contextCache.get(c.collection) ?? [];
        list.push({ path: c.path.replace(/^\/+|\/+$/g, ""), context: c.context });
        this.contextCache.set(c.collection, list);
      }
      for (const list of this.contextCache.values()) list.sort((a, b) => b.path.length - a.path.length);
    }
    const list = this.contextCache.get(collection);
    return list?.find((c) => c.path === "" || path === c.path || path.startsWith(`${c.path}/`))?.context;
  }

  // ---------- watcher ----------

  private startWatcher(name: string): void {
    if (this.watchers.has(name)) return;
    const c = this.sidecar.collection(name);
    if (!c) return;
    try {
      const w = watch(c.path, { recursive: true }, (_event, file) => {
        if (file && /(^|[\\/])\./.test(String(file))) return;
        clearTimeout(this.watchTimers.get(name));
        this.watchTimers.set(
          name,
          setTimeout(() => {
            if (!this.closed) this.sync({ collection: name, full: true });
          }, this.opts.watchDebounceMs ?? 2000),
        );
      });
      w.on("error", () => undefined);
      this.watchers.set(name, w);
    } catch {
      /* the folder cannot be watched; the plugin and `trova update` still sync it */
    }
  }

  // ---------- indexing ----------

  sync(req: SyncRequest): SyncResponse {
    const col = this.sidecar.collection(req.collection);
    if (!col) throw new EngineError("not_found", `Unknown collection "${req.collection}"`);
    for (const r of req.renamed ?? []) {
      this.sidecar.recordRename(sourceId(req.collection, r.from), sourceId(req.collection, r.to));
    }
    const jobId = this.jobs.enqueue("sync", `sync:${req.collection}`, (ctx) => this.runSync(ctx, req.collection));
    return { jobId };
  }

  private async runSync(ctx: JobCtx, name: string): Promise<void> {
    const col = this.sidecar.collection(name);
    if (!col) return;
    const hasAttachments = await syncAttachments(this.sidecar, this.paths.attachments, name, col.path, { ...col.options }, () => ctx.pause());
    if (hasAttachments && !this.attRegistered.has(name)) {
      await this.backend.addCollection(name + ATT_SUFFIX, attachmentDir(this.paths.attachments, name));
      this.attRegistered.add(name);
    }
    if (ctx.cancelled()) return;
    await ctx.pause();
    await this.backend.update(this.qmdNames([name]), (done, total) => ctx.progress(done, total, { stage: "scan", collection: name }));
    if (ctx.cancelled()) return;
    const changed = this.refreshMeta(name);
    this.vocabCache = null;
    this.sidecar.markIndexed(name, Date.now());
    if (changed.length > 0) this.emit({ event: "results.stale", data: { collection: name, sources: changed } });
    if ((await this.backend.pendingEmbeddings()) > 0) {
      this.jobs.enqueue("embed", "embed", (c) => this.runEmbed(c));
    } else {
      this.emitReady();
    }
  }

  private async runEmbed(ctx: JobCtx): Promise<void> {
    const stored = this.reader.vectorModels();
    const current = this.backend.embedModelUri();
    if (stored.length > 0 && current && stored.some((m) => m.model !== current)) {
      this.emit({ event: "model.changed", data: { model: this.backend.embedModelId(), previous: stored.map((m) => m.model) } });
    }
    await ctx.pause();
    await this.backend.embedPending(
      (done, total) => ctx.progress(done, total, { stage: "embed" }),
      () => ctx.cancelled() || this.jobs.paused,
    );
    // A pause or cancel stops the run with documents still waiting, so the index is not ready yet.
    if (!ctx.cancelled() && !this.jobs.paused) this.emitReady();
  }

  private emitReady(): void {
    const collections = this.sidecar.collectionNames().map((name) => ({ name, ...this.countsFor(name) }));
    this.emit({ event: "index.ready", data: { collections } });
  }

  private countsFor(name: string): { sources: number; embedded: number } {
    let sources = 0;
    let embedded = 0;
    for (const q of this.qmdNames([name])) {
      const c = this.reader.counts(q);
      sources += c.sources;
      embedded += c.embedded;
    }
    return { sources, embedded };
  }

  /** Brings trova_meta and trova_blocks in line with qmd's documents. Returns the changed source ids. */
  private refreshMeta(name: string): string[] {
    const col = this.sidecar.collection(name)!;
    const map = this.sidecar.entries(name);
    const seen = new Set<string>();
    const upserts: { entry: MetaEntry; blocks: Block[] }[] = [];
    const changed: string[] = [];
    for (const qmdCollection of this.qmdNames([name])) {
      for (const row of this.reader.activeDocs(qmdCollection)) {
        const path = publicPath(qmdCollection, row.path);
        seen.add(path);
        const existing = map.get(path);
        if (existing && existing.hash === row.hash) continue;
        const text = this.reader.content(row.hash) ?? "";
        let created = Date.parse(row.created_at) || Date.now();
        let modified = Date.parse(row.modified_at) || Date.now();
        try {
          const stat = statSync(join(col.path, path));
          created = stat.birthtimeMs || created;
          modified = stat.mtimeMs;
        } catch {
          /* keep qmd's timestamps */
        }
        upserts.push({ entry: buildMeta(qmdCollection, row.path, row.hash, text, { created, modified }), blocks: splitBlocks(text) });
        changed.push(sourceId(name, path));
      }
    }
    const removals = [...map.keys()].filter((p) => !seen.has(p));
    for (const p of removals) changed.push(sourceId(name, p));
    if (upserts.length > 0 || removals.length > 0) this.sidecar.apply(name, upserts, removals);
    return changed;
  }

  attachmentText(req: AttachmentTextRequest): SyncResponse {
    if (!this.sidecar.collection(req.collection)) throw new EngineError("not_found", `Unknown collection "${req.collection}"`);
    if (attachmentType(req.path) !== "image") throw new EngineError("bad_request", "Only image text can be pushed");
    storePushedText(this.sidecar, this.paths.attachments, req.collection, req.path, req.text);
    return this.sync({ collection: req.collection, changed: [req.path] });
  }

  cancelJob(jobId: string): void {
    if (!this.jobs.cancel(jobId)) throw new EngineError("not_found", `Unknown job "${jobId}"`);
  }

  // ---------- status ----------

  status(): IndexStatus {
    const models = this.backend.modelStates();
    const dims = this.reader.dims() ?? undefined;
    const hasVec = this.reader.hasVectors();
    const capabilities: Capability[] = ["lex", "fuzzy", "blocks", "attachments"];
    if (hasVec || models.embed.state !== "missing") capabilities.push("vec", "relatedByVector", "duplicates", "topics", "graph");
    if (models.rerank.state === "ready") capabilities.push("rerank");
    if (models.expand.state === "ready") capabilities.push("expansion");
    const collections = this.sidecar.collectionNames().map((name) => {
      const c = this.sidecar.collection(name)!;
      const counts = this.countsFor(name);
      const oversized = [...this.sidecar.entries(name).values()].filter((e) => e.oversized).map((e) => e.path);
      return {
        name,
        path: c.path,
        sources: counts.sources,
        embedded: counts.embedded,
        pending: Math.max(0, counts.sources - counts.embedded),
        ...(oversized.length ? { oversized } : {}),
        ...(c.lastIndexed ? { lastIndexed: c.lastIndexed } : {}),
      };
    });
    const status: IndexStatus = {
      api: API_VERSION,
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION, backend: this.backend.name },
      capabilities,
      models: { embed: { ...models.embed, ...(dims ? { dims } : {}) }, rerank: models.rerank, expand: models.expand },
      collections,
      jobs: this.jobs.active(),
      paused: this.jobs.paused,
    };
    const stored = this.reader.vectorModels();
    const current = this.backend.embedModelUri();
    const stale = stored.filter((m) => m.model !== current).reduce((sum, m) => sum + m.chunks, 0);
    if (stale > 0 && current) {
      const total = stored.reduce((sum, m) => sum + m.chunks, 0);
      status.reembedding = { done: total - stale, total };
    }
    return status;
  }

  pause(): void {
    this.jobs.pause();
  }

  async resume(): Promise<void> {
    this.jobs.resume();
    // A pause stops a running embedding run; resuming starts a new one for the documents still waiting.
    if ((await this.backend.pendingEmbeddings()) > 0 && !this.closed) this.jobs.enqueue("embed", "embed", (c) => this.runEmbed(c));
  }

  async drain(): Promise<void> {
    await this.jobs.drain();
  }

  keepWarm(): void {
    void this.backend.keepWarm();
  }

  /** Starts the download of the Deep models. The caller must have the user's confirmation. */
  downloadModels(): SyncResponse {
    const jobId = this.jobs.enqueue("models", "models", async () => {
      this.emit({ event: "engine.state", data: { state: "downloading", models: ["rerank", "expand"] } });
      await this.backend.downloadDeepModels();
      this.emit({ event: "engine.state", data: { state: "running", models: "ready" } });
    });
    return { jobId };
  }

  // ---------- result building ----------

  private filterCtx(collection: string) {
    const graph = this.sidecar.graph(collection);
    return { isOrphan: (path: string) => this.sidecar.isOrphan(collection, path), resolveLink: graph.resolve };
  }

  private passes(collection: string, entry: MetaEntry, filters: Filter[]): boolean {
    if (entry.excluded) return false;
    if (filters.length === 0) return true;
    return matchesFilters(entry, filters, this.filterCtx(collection));
  }

  private async toResult(hit: Hit, q: ParsedQuery | null, label: Result["label"]): Promise<Result> {
    const { collection, entry } = hit;
    const source = sourceId(collection, entry.path);
    const text = this.reader.content(entry.hash) ?? "";
    const blocks = this.sidecar.blocks(source);
    const fmEnd = frontmatterEnd(text);
    const ranges = q ? queryRanges(text, q).filter((r) => r[0] >= fmEnd) : [];
    let block: Block | undefined;
    let from = fmEnd;
    if (hit.pos !== undefined) {
      block = blockAt(blocks, hit.pos);
      from = Math.max(fmEnd, block?.start ?? 0, hit.pos);
    } else if (ranges.length > 0) {
      // The block with the most matches; ties go to the earliest.
      let best = 0;
      for (const b of blocks) {
        const count = ranges.filter((r) => r[0] >= b.start && r[0] < b.end).length;
        if (count > best) {
          best = count;
          block = b;
        }
      }
      from = Math.max(fmEnd, block?.start ?? 0);
    }
    const to = block ? block.end : text.length;
    let snip = makeSnippet(text, ranges, 180, Math.min(from, to), to);
    if (snip.snippet.trim() === "" && block) snip = makeSnippet(text, ranges, 180, Math.max(fmEnd, block.start), to);
    const result: Result = {
      id: block ? blockId(source, block.headingPath) : source,
      source,
      path: entry.path,
      title: entry.title,
      collection,
      snippet: snip.snippet,
      highlights: snip.highlights,
      scores: hit.scores,
      matchedBy: hit.matchedBy,
      label,
    };
    if (block) result.block = { id: blockId(source, block.headingPath), headings: block.headings, start: block.start, end: block.end };
    const type = extname(entry.path) === "md" ? null : (attachmentType(entry.path) ?? extname(entry.path));
    if (type) result.type = type;
    const context = await this.contextFor(collection, entry.path);
    if (context) result.context = context;
    return result;
  }

  // ---------- lanes ----------

  private lexHits(q: ParsedQuery, collections: string[], limit: number): Hit[] {
    const match = buildFtsQuery(q);
    const hits: Hit[] = [];
    if (!match) {
      // A query made only of filters lists the matching sources, newest first.
      if (q.filters.length === 0 || q.must.length > 0) return [];
      for (const collection of collections) {
        for (const entry of this.sidecar.entries(collection).values()) {
          if (this.passes(collection, entry, q.filters)) hits.push({ collection, entry, scores: { lex: 0 }, matchedBy: ["lex"] });
        }
      }
      return hits.sort((a, b) => b.entry.modified - a.entry.modified || (a.entry.path < b.entry.path ? -1 : 1)).slice(0, limit);
    }
    const strictGroups = q.must.filter((g) => g.some((t) => t.kind !== "word" || t.field === "heading"));
    const strictNot = q.mustNot.filter((t) => t.kind !== "word");
    const strict: ParsedQuery | null =
      strictGroups.length || strictNot.length ? { ...q, must: strictGroups, mustNot: strictNot } : null;
    const selective = strict !== null || q.filters.length > 0;
    const rows = this.reader.lex(match, this.qmdNames(collections), selective ? Math.max(200, limit * 10) : limit * 2);
    const seen = new Set<string>();
    for (const row of rows) {
      const collection = this.publicCollection(row.collection);
      const entry = this.sidecar.entry(collection, publicPath(row.collection, row.path));
      if (!entry || entry.hash !== row.hash || !this.passes(collection, entry, q.filters)) continue;
      const key = `${collection}:${entry.path}`;
      if (seen.has(key)) continue;
      if (strict) {
        const text = this.reader.content(entry.hash) ?? "";
        const headings = this.sidecar.blocks(key).flatMap((b) => b.headings.slice(-1));
        if (!matchesTerms({ title: entry.title, aliases: entry.aliases, headings, body: text }, strict)) continue;
      }
      seen.add(key);
      hits.push({ collection, entry, scores: { lex: row.score }, matchedBy: ["lex"] });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private vocabulary(): VocabEntry[] {
    if (!this.vocabCache) this.vocabCache = this.reader.vocabulary();
    return this.vocabCache;
  }

  /** The lex lane with typo rescue: when few results arrive, misspelt words are replaced from the vocabulary. */
  private lexLane(q: ParsedQuery, collections: string[], limit: number, fuzzy: boolean): { hits: Hit[]; correction?: Correction; query: ParsedQuery } {
    const hits = this.lexHits(q, collections, limit);
    if (!fuzzy || hits.length >= TYPO_RESCUE_MAX_RESULTS) return { hits, query: q };
    let rescued = q;
    const from: string[] = [];
    const to: string[] = [];
    for (const group of q.must) {
      for (const term of group) {
        if (term.kind !== "word" || typoMaxEdits(term.text) === 0 || this.reader.hasPrefix(term.text)) continue;
        const best = suggestCorrections(term.text, this.vocabulary(), 1, 5, true)[0];
        if (!best) continue;
        rescued = replaceWord(rescued, term.text, best.term);
        from.push(term.text);
        to.push(best.term);
      }
    }
    if (from.length === 0) return { hits, query: q };
    const fixed = this.lexHits(rescued, collections, limit).map((h): Hit => ({ ...h, matchedBy: ["fuzzy"] }));
    if (fixed.length <= hits.length) return { hits, query: q };
    return { hits: fixed, correction: { from: from.join(" "), to: to.join(" ") }, query: rescued };
  }

  private async vecHits(text: string, collections: string[], limit: number, filters: Filter[], asDocument = false): Promise<Hit[]> {
    if (!text.trim() || !this.reader.hasVectors()) return [];
    const vector = await this.backend.embedText(text, !asDocument);
    if (!vector) return [];
    return this.nearest(vector, collections, limit, filters, new Set());
  }

  /** Nearest stored chunks mapped to sources: one hit per source, at its best chunk. */
  private nearest(vector: Float32Array, collections: string[], limit: number, filters: Filter[], skipHashes: Set<string>, k = limit * 6): Hit[] {
    const allowed = new Set(collections);
    const near = this.reader.knn(vector, k + skipHashes.size * 4, this.qmdNames(collections)).filter((n) => !skipHashes.has(n.hash));
    const docs = this.reader.docsByHashes([...new Set(near.map((n) => n.hash))]);
    const chunkPos = this.reader.chunksFor([...docs.keys()]);
    const best = new Map<string, Hit>();
    for (const n of near) {
      for (const doc of docs.get(n.hash) ?? []) {
        const collection = this.publicCollection(doc.collection);
        if (!allowed.has(collection)) continue;
        const entry = this.sidecar.entry(collection, publicPath(doc.collection, doc.path));
        if (!entry || entry.hash !== n.hash || !this.passes(collection, entry, filters)) continue;
        const key = `${collection}:${entry.path}`;
        const prev = best.get(key);
        if (prev && (prev.scores.vec ?? 0) >= n.similarity) continue;
        const pos = chunkPos.get(n.hash)?.find((c) => c.seq === n.seq)?.pos ?? 0;
        best.set(key, { collection, entry, pos, scores: { vec: n.similarity }, matchedBy: ["vec"] });
      }
    }
    return [...best.values()].sort((a, b) => (b.scores.vec ?? 0) - (a.scores.vec ?? 0)).slice(0, limit);
  }

  private hitKey(h: Hit): string {
    return `${h.collection}:${h.entry.path}`;
  }

  private fuse(lists: Hit[][]): Hit[] {
    const byKey = new Map<string, Hit>();
    for (const list of lists) {
      for (const h of list) {
        const key = this.hitKey(h);
        const prev = byKey.get(key);
        if (!prev) byKey.set(key, { ...h, scores: { ...h.scores }, matchedBy: [...h.matchedBy] });
        else {
          prev.scores = { ...h.scores, ...prev.scores, lex: prev.scores.lex ?? h.scores.lex, vec: prev.scores.vec ?? h.scores.vec };
          for (const m of h.matchedBy) if (!prev.matchedBy.includes(m)) prev.matchedBy.push(m);
          // Keyword hits keep their matched block; a vector hit only adds its chunk position when there is none.
          if (prev.pos === undefined && !prev.matchedBy.includes("lex") && !prev.matchedBy.includes("fuzzy")) prev.pos = h.pos;
        }
      }
    }
    const fused = rrf(lists.map((items) => ({ weight: 1, items: items.map((h) => this.hitKey(h)) })));
    return fused.map((f, i) => {
      const h = byKey.get(f.id)!;
      h.scores.fused = f.score;
      h.scores.fusedRank = i + 1;
      // A source found by keywords shows its keyword block, not the vector chunk.
      if (h.matchedBy.includes("lex") || h.matchedBy.includes("fuzzy")) delete h.pos;
      return h;
    });
  }

  private async toResults(hits: Hit[], q: ParsedQuery | null, labelOf: (hit: Hit, rank: number) => Result["label"] | null): Promise<Result[]> {
    const out: Result[] = [];
    for (let i = 0; i < hits.length; i++) {
      const label = labelOf(hits[i]!, i + 1);
      if (label) out.push(await this.toResult(hits[i]!, q, label));
    }
    return out;
  }

  private cosineLabel = (hit: Hit): Result["label"] | null => labelForCosine(hit.scores.vec ?? 0, thresholdsFor(this.backend.embedModelId()));

  // ---------- search ----------

  async *search(req: SearchRequest, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
    const end = this.jobs.beginInteractive();
    try {
      this.validateQuery(req.query);
      const q = req.query;
      const collections = this.collectionsFor(req.collections);
      const limit = Math.max(1, Math.min(200, req.limit ?? 20));
      const fuzzy = req.fuzzy !== false;
      const deadline = req.deadlineMs ? Date.now() + req.deadlineMs : Infinity;
      const text = queryText(q);
      const lanes: ("lex" | "vec" | "hybrid")[] = q.lane ? [q.lane === "lex" ? "lex" : "vec"] : req.lanes?.length ? req.lanes : ["lex"];
      let lex: { hits: Hit[]; correction?: Correction; query: ParsedQuery } | null = null;
      const getLex = () => (lex ??= this.lexLane(q, collections, limit, fuzzy));
      for (let i = 0; i < lanes.length; i++) {
        checkAborted(signal);
        const lane = lanes[i]!;
        const last = i === lanes.length - 1;
        if (lane === "lex") {
          const l = getLex();
          const results = await this.toResults(l.hits, l.query, (_h, rank) => labelForRank(rank));
          yield { stage: "lex", results, final: last, ...(l.correction ? { correction: l.correction } : {}) };
        } else if (lane === "vec") {
          const hits = await withTimeout(this.vecHits(text, collections, limit, q.filters, q.lane === "hyde"), deadline - Date.now());
          checkAborted(signal);
          const results = hits === "timeout" ? [] : await this.toResults(hits, q, this.cosineLabel);
          yield { stage: "vec", results, final: last };
        } else {
          const l = getLex();
          if (!lanes.includes("lex")) {
            const results = await this.toResults(l.hits, l.query, (_h, rank) => labelForRank(rank));
            yield { stage: "lex", results, final: false, ...(l.correction ? { correction: l.correction } : {}) };
          }
          const vec = await withTimeout(this.vecHits(text, collections, limit, q.filters), deadline - Date.now());
          checkAborted(signal);
          const fused = this.fuse([l.hits, vec === "timeout" ? [] : vec]).slice(0, limit);
          yield { stage: "fused", results: await this.toResults(fused, l.query, (_h, rank) => labelForRank(rank)), final: last };
        }
        if (Date.now() > deadline && !last) {
          yield { stage: lane === "hybrid" ? "fused" : lane, results: [], final: true };
          return;
        }
      }
    } finally {
      end();
    }
  }

  private validateQuery(q: unknown): asserts q is ParsedQuery {
    const p = q as ParsedQuery | undefined;
    if (!p || !Array.isArray(p.must) || !Array.isArray(p.mustNot) || !Array.isArray(p.filters)) {
      throw new EngineError("bad_request", "The request needs a parsed query with must, mustNot and filters");
    }
  }

  // ---------- ask ----------

  async *ask(req: AskRequest, signal?: AbortSignal): AsyncGenerator<ResultBatch> {
    const end = this.jobs.beginInteractive();
    try {
      this.validateQuery(req.query);
      const q = req.query;
      const collections = this.collectionsFor(req.collections);
      const limit = Math.max(1, Math.min(100, req.limit ?? ASK_FAST_LIMIT));
      const fuzzy = req.fuzzy !== false;
      const text = queryText(q);
      const rankLabel = (_h: Hit, rank: number) => labelForRank(rank);

      // A lane prefix skips routing and runs only that lane.
      if (q.lane) {
        if (q.lane === "lex") {
          const l = this.lexLane(q, collections, limit, fuzzy);
          yield { stage: "lex", results: await this.toResults(l.hits, l.query, rankLabel), final: true, ...(l.correction ? { correction: l.correction } : {}) };
        } else {
          const hits = await this.vecHits(text, collections, limit, q.filters, q.lane === "hyde");
          yield { stage: "vec", results: await this.toResults(hits, q, rankLabel), final: true };
        }
        return;
      }

      let mode: "fast" | "deep" = req.mode === "auto" || !req.mode ? pickAskMode(q) : req.mode;
      const started = Date.now();
      const deadline = started + (req.deadlineMs ?? ASK_DEEP_DEADLINE_MS);

      const lex = this.lexLane(q, collections, ASK_LANE_LIMIT, fuzzy);
      this.relaxLex(lex, collections);
      yield {
        stage: "lex",
        results: await this.toResults(lex.hits.slice(0, limit), lex.query, rankLabel),
        final: false,
        mode,
        ...(lex.correction ? { correction: lex.correction } : {}),
      };
      checkAborted(signal);

      const vec = await this.vecHits(text, collections, ASK_LANE_LIMIT, q.filters);
      checkAborted(signal);
      const fused = this.fuse([lex.hits, vec]);
      const fusedResults = await this.toResults(fused.slice(0, limit), lex.query, rankLabel);

      let note: ResultBatch["note"];
      if (mode === "deep" && !this.backend.deepReady()) {
        // Deep models are not downloaded: run Fast and let the client offer the download.
        if (req.allowModelDownload) this.downloadModels();
        mode = "fast";
        note = "model_missing";
      }
      if (mode === "fast") {
        yield { stage: "fused", results: fusedResults, final: true, mode, ...(note ? { note } : {}) };
        return;
      }
      yield { stage: "fused", results: fusedResults, final: false, mode };

      const deep = await withTimeout(this.deepPass(q, lex, vec, collections, limit, fuzzy, signal), deadline - Date.now());
      checkAborted(signal);
      if (deep === "timeout") {
        yield { stage: "fused", results: fusedResults, final: true, mode, note: "rerank_skipped" };
        return;
      }
      yield { stage: "rerank", results: deep.results, final: true, mode, expansions: deep.expansions };
    } finally {
      end();
    }
  }

  /**
   * A question rarely has every word in one note. When the all-words query finds few hits, Ask
   * adds the notes that match any of its content words, ranked by BM25 behind the strict hits.
   */
  private relaxLex(lex: { hits: Hit[]; query: ParsedQuery }, collections: string[]): void {
    const q = lex.query;
    if (lex.hits.length >= ASK_RELAX_BELOW || q.must.length < 2) return;
    const words = q.must.flat().filter((t) => t.kind !== "word" || !ASK_STOPWORDS.has(t.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")));
    if (words.length < 2) return;
    const relaxed: ParsedQuery = { ...q, must: [words] };
    const seen = new Set(lex.hits.map((h) => this.hitKey(h)));
    for (const h of this.lexHits(relaxed, collections, ASK_LANE_LIMIT)) {
      if (!seen.has(this.hitKey(h)) && lex.hits.length < ASK_LANE_LIMIT) lex.hits.push(h);
    }
    lex.query = relaxed;
  }

  private async deepPass(
    q: ParsedQuery,
    lex: { hits: Hit[]; query: ParsedQuery },
    vec: Hit[],
    collections: string[],
    limit: number,
    fuzzy: boolean,
    signal?: AbortSignal,
  ): Promise<{ results: Result[]; expansions: { type: Lane; query: string }[] }> {
    const text = queryText(q);
    const expansions = (await this.backend.expand(text)).filter((e) => e.query.trim() && e.query.trim().toLowerCase() !== text.toLowerCase());
    const lists: Hit[][] = [lex.hits, vec];
    for (const sub of expansions) {
      // A model call that already runs finishes; cancellation is checked between stages.
      if (signal?.aborted) break;
      if (sub.type === "lex") {
        const parsed = parseQuery(sub.query, { mode: "ask" }).query;
        lists.push(this.lexLane({ ...parsed, filters: q.filters }, collections, ASK_LANE_LIMIT, fuzzy).hits);
      } else {
        lists.push(await this.vecHits(sub.query, collections, ASK_LANE_LIMIT, q.filters, sub.type === "hyde"));
      }
    }
    const fused = this.fuse(lists);
    const top = fused.slice(0, ASK_RERANK_TOP);
    const prelim = await this.toResults(top, lex.query, (_h, rank) => labelForRank(rank));
    const docs = prelim.map((r) => {
      const entry = this.sidecar.entry(r.collection!, r.path)!;
      const full = this.reader.content(entry.hash) ?? "";
      const body = r.block ? full.slice(r.block.start, r.block.end) : full.slice(frontmatterEnd(full));
      return { id: r.id, text: `${r.title}\n${body}`.slice(0, 2400) };
    });
    const scores = await this.backend.rerank(text, docs);
    const maxFused = Math.max(...prelim.map((r) => r.scores.fused ?? 0), 1e-9);
    const blended = prelim
      .map((r, i) => {
        const rerank = scores.get(r.id);
        const final = rerank === undefined ? (r.scores.fused ?? 0) / maxFused : blendRerank(i + 1, (r.scores.fused ?? 0) / maxFused, rerank);
        const matchedBy: MatchedBy[] = rerank === undefined ? r.matchedBy : [...r.matchedBy, "rerank"];
        return { r: { ...r, matchedBy, scores: { ...r.scores, ...(rerank === undefined ? {} : { rerank }) } }, final };
      })
      .sort((a, b) => b.final - a.final)
      .slice(0, limit)
      .map(({ r }, i) => ({ ...r, label: labelForRank(i + 1) }));
    return { results: blended, expansions };
  }

  // ---------- related ----------

  private locate(id: string): { collection: string; entry: MetaEntry; headingPath?: string } | null {
    let parsed = parseId(id);
    if (!parsed) return null;
    if (!this.sidecar.collection(parsed.collection)) return null;
    let entry = this.sidecar.entry(parsed.collection, parsed.path);
    if (!entry) {
      // The id may predate a rename.
      const current = parseId(this.sidecar.currentId(parsed.source));
      if (current) {
        entry = this.sidecar.entry(current.collection, current.path);
        if (entry) parsed = { ...current, headingPath: parsed.headingPath };
      }
    }
    if (!entry || entry.excluded) return null;
    return { collection: parsed.collection, entry, headingPath: parsed.headingPath };
  }

  /** The vector of an anchor: stored vectors for a source or block, a fresh embedding for text. */
  private async anchorVector(anchor: EngineAnchor): Promise<AnchorVector | null> {
    const set = [anchor.source, anchor.block, anchor.text].filter((v) => v != null && v !== "");
    if (set.length !== 1) throw new EngineError("bad_request", "Exactly one of source, block or text must be set on the anchor");
    if (anchor.text) {
      if (!this.reader.hasVectors()) return null;
      const vector = await this.backend.embedText(anchor.text, false);
      return vector ? { vector, text: anchor.text } : null;
    }
    const id = (anchor.block ?? anchor.source)!;
    const found = this.locate(id);
    if (!found) throw new EngineError("not_found", `Unknown source or block "${id}"`);
    const { collection, entry } = found;
    const chunks = this.reader.chunks(entry.hash);
    if (chunks.length === 0) return null;
    const full = this.reader.content(entry.hash) ?? "";
    let wanted = chunks;
    let text = full;
    if (anchor.block) {
      const block = findBlock(this.sidecar.blocks(sourceId(collection, entry.path)), found.headingPath ?? "");
      if (!block) throw new EngineError("not_found", `Unknown block "${id}"`);
      // A block's vector is the normalised mean of the chunks that overlap it.
      wanted = chunks.filter((c, i) => {
        const chunkEnd = i + 1 < chunks.length ? chunks[i + 1]!.pos : full.length;
        return c.pos < block.end && Math.max(chunkEnd, c.pos + 1) > block.start;
      });
      if (wanted.length === 0) wanted = [chunks[chunks.length - 1]!];
      text = blockText(full, block);
    }
    const vectors = this.reader.vectors(wanted.map((c) => `${c.hash}_${c.seq}`));
    const vector = meanVector([...vectors.values()]);
    return vector ? { vector, collection, entry, text } : null;
  }

  async related(req: RelatedRequest, signal?: AbortSignal): Promise<RelatedResponse> {
    return this.jobs.interactiveCall(async () => {
      if (!req.anchor) throw new EngineError("bad_request", "The request needs an anchor");
      const anchor = await this.anchorVector(req.anchor);
      checkAborted(signal);
      if (!anchor) return { anchorIndexed: false, results: [] };
      const collections = this.collectionsFor(req.collections);
      const limit = Math.max(1, Math.min(100, req.limit ?? 20));
      const perSource = Math.max(1, req.blocksPerSource ?? 3);
      const thresholds = thresholdsFor(this.backend.embedModelId());
      const granularity = req.granularity ?? "both";
      const filters = req.filters ?? [];
      const excluded = new Set((req.exclude?.sources ?? []).map((s) => parseId(s)?.source ?? s));
      const anchorSource = anchor.entry ? sourceId(anchor.collection!, anchor.entry.path) : null;
      if (anchor.entry && req.exclude?.linkedFromAnchor) {
        this.sidecar.graph(anchor.collection!);
        for (const l of anchor.entry.links) excluded.add(sourceId(anchor.collection!, l));
      }

      // 1. The nearest chunks, without the anchor's own source.
      const own = anchor.entry ? new Set([anchor.entry.hash]) : new Set<string>();
      const ownChunks = anchor.entry ? this.reader.chunks(anchor.entry.hash).length : 0;
      const near = this.reader.knn(anchor.vector, RELATED_NEAREST_CHUNKS + ownChunks, this.qmdNames(collections)).filter((n) => !own.has(n.hash)).slice(0, RELATED_NEAREST_CHUNKS);
      const docs = this.reader.docsByHashes([...new Set(near.map((n) => n.hash))]);
      const chunkPos = this.reader.chunksFor([...docs.keys()]);

      // 2. Chunks to blocks: a block's score is its best chunk's cosine similarity.
      interface SourceHit {
        collection: string;
        entry: MetaEntry;
        blocks: Map<string, { block: Block; score: number; pos: number }>;
      }
      const sources = new Map<string, SourceHit>();
      const allowed = new Set(collections);
      for (const n of near) {
        for (const doc of docs.get(n.hash) ?? []) {
          const collection = this.publicCollection(doc.collection);
          if (!allowed.has(collection)) continue;
          const entry = this.sidecar.entry(collection, publicPath(doc.collection, doc.path));
          if (!entry || entry.hash !== n.hash) continue;
          const source = sourceId(collection, entry.path);
          if (source === anchorSource || excluded.has(source) || !this.passes(collection, entry, filters)) continue;
          const pos = chunkPos.get(n.hash)?.find((c) => c.seq === n.seq)?.pos ?? 0;
          const block = blockAt(this.sidecar.blocks(source), pos);
          if (!block) continue;
          let s = sources.get(source);
          if (!s) sources.set(source, (s = { collection, entry, blocks: new Map() }));
          const prev = s.blocks.get(block.headingPath);
          if (!prev || prev.score < n.similarity) s.blocks.set(block.headingPath, { block, score: n.similarity, pos });
        }
      }

      // 3. Source scores, labels and results.
      const anchorKeywords = new Set(anchor.text ? keywords(anchor.text) : []);
      const anchorLinks = new Set(anchor.entry?.links ?? []);
      const anchorTags = new Set(anchor.entry?.tags ?? []);
      const scored = [...sources.values()]
        .map((s) => {
          const blocks = [...s.blocks.values()].sort((a, b) => b.score - a.score);
          return { ...s, ranked: blocks, best: blocks[0]!.score, score: sourceScore(blocks.map((b) => b.score), thresholds) };
        })
        .filter((s) => {
          const label = labelForCosine(s.best, thresholds);
          return label !== null && (label !== "loose" || req.loose === true);
        })
        .sort((a, b) => b.score - a.score || (a.entry.path < b.entry.path ? -1 : 1));

      const results: Result[] = [];
      for (const s of scored) {
        checkAborted(signal);
        const blockResults: Result[] = [];
        for (const b of s.ranked.slice(0, perSource)) {
          const label = labelForCosine(b.score, thresholds);
          if (!label || (label === "loose" && !req.loose)) continue;
          blockResults.push(await this.toResult({ collection: s.collection, entry: s.entry, pos: b.block.start, scores: { vec: b.score }, matchedBy: ["vec"] }, null, label));
        }
        if (granularity === "block") {
          results.push(...blockResults);
          continue;
        }
        const top = await this.toResult(
          { collection: s.collection, entry: s.entry, pos: s.ranked[0]!.block.start, scores: { vec: s.best, fused: s.score }, matchedBy: ["vec"] },
          null,
          labelForCosine(s.best, thresholds)!,
        );
        const sourceResult: Result = { ...top, id: top.source };
        delete sourceResult.block;
        if (granularity === "both") sourceResult.blocks = blockResults;
        const full = this.reader.content(s.entry.hash) ?? "";
        this.sidecar.graph(s.collection);
        const sameCollection = s.collection === anchor.collection;
        const links = sameCollection ? s.entry.links.filter((l) => anchorLinks.has(l)) : [];
        if (sameCollection && anchor.entry) {
          if (s.entry.links.includes(anchor.entry.path)) links.push(anchor.entry.path);
          if (anchorLinks.has(s.entry.path)) links.push(s.entry.path);
        }
        sourceResult.why = {
          keywords: keywords(full.slice(s.ranked[0]!.block.start, s.ranked[0]!.block.end), 200).filter((w) => anchorKeywords.has(w)).slice(0, 6),
          links: [...new Set(links)],
          tags: s.entry.tags.filter((t) => anchorTags.has(t)),
        };
        results.push(sourceResult);
      }
      if (granularity === "block") results.sort((a, b) => (b.scores.vec ?? 0) - (a.scores.vec ?? 0));
      return { anchorIndexed: true, results: results.slice(0, limit) };
    });
  }

  async score(req: ScoreRequest): Promise<ScoreResponse> {
    if (!Array.isArray(req.pairs)) throw new EngineError("bad_request", "The request needs pairs");
    const scores: (number | null)[] = [];
    for (const [a, b] of req.pairs) {
      const va = await this.anchorVector(a);
      const vb = await this.anchorVector(b);
      scores.push(va && vb ? Math.max(0, Math.min(1, cosine(va.vector, vb.vector))) : null);
    }
    return { scores };
  }

  // ---------- similarity graph ----------

  private noteVectors = new Map<string, Float32Array | null>();

  /** The vector of a whole source: the normalised mean of its chunk vectors. Cached by content hash. */
  private noteVector(hash: string): Float32Array | null {
    const hit = this.noteVectors.get(hash);
    if (hit !== undefined) return hit;
    const keys = this.reader.chunks(hash).map((c) => `${c.hash}_${c.seq}`);
    const vector = keys.length ? meanVector([...this.reader.vectors(keys).values()]) : null;
    if (this.noteVectors.size >= 4000) this.noteVectors.delete(this.noteVectors.keys().next().value!);
    this.noteVectors.set(hash, vector ?? null);
    return vector ?? null;
  }

  /**
   * The similarity graph around one anchor: the related sources, an edge from the anchor to each,
   * and edges between related sources whose note vectors are similar. Each source keeps at most
   * `GRAPH_EDGES_PER_NODE` such edges, so the picture stays readable.
   */
  async graph(req: GraphRequest, signal?: AbortSignal): Promise<GraphResponse> {
    const limit = Math.max(1, Math.min(60, req.limit ?? 24));
    const related = await this.related({ anchor: req.anchor, granularity: "source", limit, collections: req.collections, filters: req.filters, loose: req.loose }, signal);
    if (!related.anchorIndexed) return { anchorIndexed: false, anchor: null, nodes: [], edges: [] };
    return this.jobs.interactiveCall(async () => {
      const thresholds = thresholdsFor(this.backend.embedModelId());
      const anchorId = req.anchor.source ?? (req.anchor.block ? parseId(req.anchor.block)?.source : null) ?? null;
      const anchorFound = anchorId ? this.locate(anchorId) : null;
      const anchor: GraphNode | null = anchorFound
        ? { id: sourceId(anchorFound.collection, anchorFound.entry.path), path: anchorFound.entry.path, title: anchorFound.entry.title, collection: anchorFound.collection, score: 1, label: "strong", snippet: "", tags: anchorFound.entry.tags }
        : null;
      const located = new Map<string, { collection: string; entry: MetaEntry }>();
      const nodes: GraphNode[] = [];
      for (const r of related.results) {
        const found = this.locate(r.source);
        if (!found) continue;
        this.sidecar.graph(found.collection);
        located.set(r.source, found);
        nodes.push({ id: r.source, path: r.path, title: r.title, collection: found.collection, score: r.scores.vec ?? 0, label: r.label, snippet: r.snippet, tags: found.entry.tags });
      }
      const linked = (a: { collection: string; entry: MetaEntry }, b: { collection: string; entry: MetaEntry }) =>
        a.collection === b.collection && (a.entry.links.includes(b.entry.path) || b.entry.links.includes(a.entry.path));
      const edges: GraphEdge[] = [];
      if (anchor && anchorFound) {
        this.sidecar.graph(anchorFound.collection);
        for (const n of nodes) edges.push({ a: anchor.id, b: n.id, similarity: n.score, linked: linked(anchorFound, located.get(n.id)!) });
      }
      checkAborted(signal);
      // Edges between the related sources, from their note vectors.
      const vectors = nodes.map((n) => this.noteVector(located.get(n.id)!.entry.hash));
      const candidates: { i: number; j: number; similarity: number }[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const vi = vectors[i];
        if (!vi) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const vj = vectors[j];
          if (!vj) continue;
          const similarity = cosine(vi, vj);
          if (similarity >= thresholds.related) candidates.push({ i, j, similarity });
        }
      }
      candidates.sort((x, y) => y.similarity - x.similarity);
      const degree = Array.from({ length: nodes.length }, () => 0);
      for (const c of candidates) {
        if (degree[c.i]! >= GRAPH_EDGES_PER_NODE || degree[c.j]! >= GRAPH_EDGES_PER_NODE) continue;
        degree[c.i]!++;
        degree[c.j]!++;
        const a = nodes[c.i]!;
        const b = nodes[c.j]!;
        edges.push({ a: a.id, b: b.id, similarity: Math.min(1, c.similarity), linked: linked(located.get(a.id)!, located.get(b.id)!) });
      }
      return { anchorIndexed: true, anchor, nodes, edges };
    });
  }

  // ---------- vocabulary and metadata ----------

  vocabSuggest(req: VocabSuggestRequest): VocabSuggestResponse {
    if (!Array.isArray(req.terms)) throw new EngineError("bad_request", "The request needs terms");
    const suggestions: VocabSuggestResponse["suggestions"] = {};
    for (const term of req.terms) {
      suggestions[term] = this.reader.hasPrefix(term) && typoMaxEdits(term) === 0 ? [] : suggestCorrections(term, this.vocabulary(), 1, 5, true);
    }
    return { suggestions };
  }

  metadataKeys(collections?: string[]): MetadataKeysResponse {
    const keys = new Map<string, Set<string>>();
    for (const collection of this.collectionsFor(collections)) {
      for (const entry of this.sidecar.entries(collection).values()) {
        if (entry.excluded) continue;
        for (const [key, value] of Object.entries(entry.frontmatter)) {
          const k = key.toLowerCase();
          let set = keys.get(k);
          if (!set) keys.set(k, (set = new Set()));
          for (const v of Array.isArray(value) ? value : [value]) {
            if (set.size < 50 && v != null && typeof v !== "object") set.add(String(v));
          }
        }
      }
    }
    return { keys: Object.fromEntries([...keys.entries()].sort(([a], [b]) => compareText(a, b)).map(([k, v]) => [k, [...v].sort(compareText)])) };
  }

  // ---------- documents ----------

  private body(collection: string, entry: MetaEntry, headingPath: string | undefined, neighbours = 0): DocumentBody {
    const source = sourceId(collection, entry.path);
    const text = this.reader.content(entry.hash) ?? "";
    if (headingPath === undefined) {
      return { id: source, source, path: entry.path, title: entry.title, content: text };
    }
    const blocks = this.sidecar.blocks(source);
    const index = blocks.findIndex((b) => b.headingPath === headingPath);
    if (index === -1) throw new EngineError("not_found", `Unknown block "${source}#${headingPath}"`);
    const make = (b: Block): DocumentBody => ({
      id: blockId(source, b.headingPath),
      source,
      path: entry.path,
      title: entry.title,
      block: { id: blockId(source, b.headingPath), headings: b.headings, start: b.start, end: b.end },
      content: blockText(text, b),
    });
    const doc = make(blocks[index]!);
    if (neighbours > 0) {
      doc.neighbours = {
        before: blocks.slice(Math.max(0, index - neighbours), index).map(make),
        after: blocks.slice(index + 1, index + 1 + neighbours).map(make),
      };
    }
    return doc;
  }

  get(req: GetRequest): DocumentBody {
    if (!req.id) throw new EngineError("bad_request", "The request needs an id");
    let found = this.locate(req.id);
    if (!found) {
      // A bare path, relative to the given collection or to any collection.
      const [path, heading] = req.id.split(/#(.*)/s) as [string, string | undefined];
      for (const collection of this.collectionsFor(req.collection ? [req.collection] : undefined)) {
        const entry = this.sidecar.entry(collection, path) ?? this.sidecar.entry(collection, `${path}.md`);
        if (entry && !entry.excluded) {
          found = { collection, entry, headingPath: heading };
          break;
        }
      }
    }
    if (!found) throw new EngineError("not_found", `Unknown source or block "${req.id}"`);
    return this.body(found.collection, found.entry, found.headingPath, req.neighbours ?? 0);
  }

  multiGet(req: MultiGetRequest): MultiGetResponse {
    const documents: DocumentBody[] = [];
    const errors: MultiGetResponse["errors"] = [];
    const maxBytes = req.maxBytes ?? 512 * 1024;
    let bytes = 0;
    const push = (doc: DocumentBody): boolean => {
      bytes += Buffer.byteLength(doc.content);
      if (bytes > maxBytes && documents.length > 0) return false;
      documents.push(doc);
      return true;
    };
    for (const id of req.ids ?? []) {
      try {
        if (!push(this.get({ id, collection: req.collection }))) break;
      } catch (err) {
        errors.push({ id, code: err instanceof EngineError ? err.code : "internal" });
      }
    }
    if (req.glob) {
      const isMatch = picomatch(req.glob, { nocase: true });
      outer: for (const collection of this.collectionsFor(req.collection ? [req.collection] : undefined)) {
        for (const entry of [...this.sidecar.entries(collection).values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
          if (entry.excluded || !isMatch(entry.path)) continue;
          if (!push(this.body(collection, entry, undefined))) break outer;
        }
      }
    }
    return { documents, errors };
  }

  // ---------- background analysis ----------

  private analysisInput() {
    return {
      reader: this.reader,
      collections: this.sidecar.collectionNames().map((name) => ({
        name,
        qmdNames: this.qmdNames([name]),
        entries: this.sidecar.entries(name),
        blocks: (source: string) => this.sidecar.blocks(source),
      })),
    };
  }

  getDuplicates(start: boolean): DuplicatesResponse {
    if (start && this.duplicates.state !== "running") {
      const jobId = this.jobs.enqueue("duplicates", "duplicates", async (ctx) => {
        const pairs = await findDuplicates(this.analysisInput(), ctx);
        if (ctx.cancelled()) {
          this.duplicates = { ...this.duplicates, state: this.duplicates.computedAt ? "done" : "none" };
          return;
        }
        this.duplicates = { state: "done", pairs, computedAt: Date.now() };
        this.sidecar.setValue("duplicates", this.duplicates);
      });
      this.duplicates = { ...this.duplicates, state: "running", jobId };
    }
    return this.duplicates;
  }

  getTopics(start: boolean): TopicsResponse {
    if (start && this.topics.state !== "running") {
      const jobId = this.jobs.enqueue("topics", "topics", async (ctx) => {
        const clusters = await findTopics(this.analysisInput(), ctx);
        if (ctx.cancelled()) {
          this.topics = { ...this.topics, state: this.topics.computedAt ? "done" : "none" };
          return;
        }
        this.topics = { state: "done", clusters, computedAt: Date.now() };
        this.sidecar.setValue("topics", this.topics);
      });
      this.topics = { ...this.topics, state: "running", jobId };
    }
    return this.topics;
  }

  renameHistory(): { old_id: string; new_id: string; at: number }[] {
    return this.sidecar.renameHistory();
  }
}
