// trova.sqlite: the sidecar tables next to qmd's index, plus an in-memory copy of the metadata
// that filters and graph operators read on every query.

import Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import {
  countWords,
  createLinkResolver,
  extname,
  extractInlineTags,
  extractLinks,
  frontmatterEnd,
  frontmatterText,
  inScope,
  isExcludedByFrontmatter,
  MAX_TEXT_BYTES,
  normaliseAliases,
  normaliseTags,
  splitBlocks,
  titleFromPath,
  type Block,
  type CollectionOptions,
  type JobInfo,
  type LinkResolver,
  type SourceMeta,
} from "@trova/contract";

export interface MetaEntry extends SourceMeta {
  hash: string;
  /** The qmd collection and path that hold this source's text. For attachments these differ from the public ones. */
  qmdCollection: string;
  qmdPath: string;
  rawLinks: string[];
  /** Set by frontmatter `trova: false`. Scope globs are applied on top of it. */
  fmExcluded: boolean;
  oversized: boolean;
}

export interface CollectionGraph {
  resolve: LinkResolver;
  inbound: Map<string, number>;
}

export const ATT_SUFFIX = "-att";

/** Attachment text lives in a sidecar markdown file named `<original path>.md`. */
export function publicPath(qmdCollection: string, qmdPath: string): string {
  return qmdCollection.endsWith(ATT_SUFFIX) ? qmdPath.replace(/\.md$/, "") : qmdPath;
}

export function parseFrontmatter(text: string): Record<string, unknown> {
  const raw = frontmatterText(text);
  if (!raw) return {};
  try {
    const value = parseYaml(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildMeta(
  qmdCollection: string,
  qmdPath: string,
  hash: string,
  text: string,
  times: { created: number; modified: number },
): MetaEntry {
  const path = publicPath(qmdCollection, qmdPath);
  const isNote = extname(path) === "md";
  const fm = isNote ? parseFrontmatter(text) : {};
  const tags = new Set([...normaliseTags(fm["tags"]), ...normaliseTags(fm["tag"]), ...(isNote ? extractInlineTags(text) : [])]);
  const fmExcluded = isExcludedByFrontmatter(fm);
  return {
    path,
    title: titleFromPath(path),
    aliases: [...normaliseAliases(fm["aliases"]), ...normaliseAliases(fm["alias"])],
    tags: [...tags],
    links: [],
    rawLinks: isNote ? [...new Set(extractLinks(text).map((l) => l.target))] : [],
    frontmatter: fm,
    created: times.created,
    modified: times.modified,
    wordCount: countWords(text.slice(frontmatterEnd(text))),
    excluded: fmExcluded,
    fmExcluded,
    hash,
    qmdCollection,
    qmdPath,
    oversized: Buffer.byteLength(text) > MAX_TEXT_BYTES,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trova_meta (
  source_id TEXT PRIMARY KEY, collection TEXT NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL,
  aliases TEXT NOT NULL, tags TEXT NOT NULL, links TEXT NOT NULL, frontmatter TEXT NOT NULL,
  created INTEGER NOT NULL, modified INTEGER NOT NULL, word_count INTEGER NOT NULL, excluded INTEGER NOT NULL,
  qmd_collection TEXT NOT NULL, qmd_path TEXT NOT NULL, oversized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trova_meta_collection ON trova_meta(collection);
CREATE TABLE IF NOT EXISTS trova_blocks (
  block_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, heading_path TEXT NOT NULL, headings TEXT NOT NULL,
  level INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trova_blocks_source ON trova_blocks(source_id, start);
CREATE TABLE IF NOT EXISTS trova_paths (old_id TEXT NOT NULL, new_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_trova_paths_old ON trova_paths(old_id);
CREATE TABLE IF NOT EXISTS trova_jobs (
  job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, done INTEGER NOT NULL, total INTEGER NOT NULL,
  error TEXT, started INTEGER, finished INTEGER
);
CREATE TABLE IF NOT EXISTS trova_collections (name TEXT PRIMARY KEY, path TEXT NOT NULL, options TEXT NOT NULL, last_indexed INTEGER);
CREATE TABLE IF NOT EXISTS trova_attachments (
  collection TEXT NOT NULL, path TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, pushed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, path)
);
CREATE TABLE IF NOT EXISTS trova_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

interface MetaRow {
  source_id: string;
  collection: string;
  hash: string;
  title: string;
  aliases: string;
  tags: string;
  links: string;
  frontmatter: string;
  created: number;
  modified: number;
  word_count: number;
  excluded: number;
  qmd_collection: string;
  qmd_path: string;
  oversized: number;
}

export class Sidecar {
  private db: Database.Database;
  private metas = new Map<string, Map<string, MetaEntry>>();
  private graphs = new Map<string, CollectionGraph>();
  private options = new Map<string, { path: string; options: CollectionOptions; lastIndexed?: number }>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    for (const row of this.db.prepare(`SELECT name, path, options, last_indexed FROM trova_collections`).all() as {
      name: string;
      path: string;
      options: string;
      last_indexed: number | null;
    }[]) {
      this.options.set(row.name, { path: row.path, options: JSON.parse(row.options) as CollectionOptions, lastIndexed: row.last_indexed ?? undefined });
    }
    // A job that was running when the process stopped can never finish.
    this.db.prepare(`UPDATE trova_jobs SET state = 'failed', error = 'engine stopped' WHERE state IN ('running', 'queued', 'paused')`).run();
  }

  close(): void {
    this.db.close();
  }

  // ---------- collections ----------

  collectionNames(): string[] {
    return [...this.options.keys()];
  }

  collection(name: string): { path: string; options: CollectionOptions; lastIndexed?: number } | undefined {
    return this.options.get(name);
  }

  saveCollection(name: string, path: string, options: CollectionOptions): void {
    const prev = this.options.get(name);
    this.options.set(name, { path, options, lastIndexed: prev?.lastIndexed });
    this.db
      .prepare(`INSERT INTO trova_collections (name, path, options) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path, options = excluded.options`)
      .run(name, path, JSON.stringify(options));
    this.applyScope(name);
  }

  markIndexed(name: string, at: number): void {
    const c = this.options.get(name);
    if (c) c.lastIndexed = at;
    this.db.prepare(`UPDATE trova_collections SET last_indexed = ? WHERE name = ?`).run(at, name);
  }

  removeCollection(name: string): void {
    this.options.delete(name);
    this.metas.delete(name);
    this.graphs.delete(name);
    // An exact prefix: LIKE would treat "_" in the name as a wildcard and ignore letter case.
    const prefix = `${name}:`;
    this.db.prepare(`DELETE FROM trova_collections WHERE name = ?`).run(name);
    this.db.prepare(`DELETE FROM trova_blocks WHERE substr(source_id, 1, ?) = ?`).run(prefix.length, prefix);
    this.db.prepare(`DELETE FROM trova_meta WHERE collection = ?`).run(name);
    this.db.prepare(`DELETE FROM trova_attachments WHERE collection = ?`).run(name);
  }

  // ---------- metadata ----------

  private applyScope(collection: string): void {
    const opts = this.options.get(collection)?.options;
    const map = this.metas.get(collection);
    if (!map) return;
    for (const e of map.values()) e.excluded = e.fmExcluded || !inScope(e.path, opts?.include, opts?.exclude);
  }

  entries(collection: string): Map<string, MetaEntry> {
    let map = this.metas.get(collection);
    if (map) return map;
    map = new Map();
    const rows = this.db.prepare(`SELECT * FROM trova_meta WHERE collection = ?`).all(collection) as MetaRow[];
    for (const r of rows) {
      const path = r.source_id.slice(collection.length + 1);
      map.set(path, {
        path,
        title: r.title,
        aliases: JSON.parse(r.aliases) as string[],
        tags: JSON.parse(r.tags) as string[],
        links: [],
        rawLinks: JSON.parse(r.links) as string[],
        frontmatter: JSON.parse(r.frontmatter) as Record<string, unknown>,
        created: r.created,
        modified: r.modified,
        wordCount: r.word_count,
        excluded: r.excluded === 1,
        fmExcluded: r.excluded === 1,
        hash: r.hash,
        qmdCollection: r.qmd_collection,
        qmdPath: r.qmd_path,
        oversized: r.oversized === 1,
      });
    }
    this.metas.set(collection, map);
    this.applyScope(collection);
    return map;
  }

  entry(collection: string, path: string): MetaEntry | undefined {
    return this.entries(collection).get(path);
  }

  /** Writes changed sources and removes deleted ones in one transaction. */
  apply(collection: string, upserts: { entry: MetaEntry; blocks: Block[] }[], removals: string[]): void {
    const map = this.entries(collection);
    const putMeta = this.db.prepare(
      `INSERT OR REPLACE INTO trova_meta (source_id, collection, hash, title, aliases, tags, links, frontmatter, created, modified, word_count, excluded, qmd_collection, qmd_path, oversized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const delBlocks = this.db.prepare(`DELETE FROM trova_blocks WHERE source_id = ?`);
    const putBlock = this.db.prepare(
      `INSERT OR REPLACE INTO trova_blocks (block_id, source_id, heading_path, headings, level, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const delMeta = this.db.prepare(`DELETE FROM trova_meta WHERE source_id = ?`);
    this.db.transaction(() => {
      for (const { entry, blocks } of upserts) {
        const id = `${collection}:${entry.path}`;
        putMeta.run(
          id,
          collection,
          entry.hash,
          entry.title,
          JSON.stringify(entry.aliases),
          JSON.stringify(entry.tags),
          JSON.stringify(entry.rawLinks),
          JSON.stringify(entry.frontmatter),
          Math.round(entry.created),
          Math.round(entry.modified),
          entry.wordCount,
          entry.fmExcluded ? 1 : 0,
          entry.qmdCollection,
          entry.qmdPath,
          entry.oversized ? 1 : 0,
        );
        delBlocks.run(id);
        for (const b of blocks) putBlock.run(`${id}#${b.headingPath}`, id, b.headingPath, JSON.stringify(b.headings), b.level, b.start, b.end);
        map.set(entry.path, entry);
      }
      for (const path of removals) {
        const id = `${collection}:${path}`;
        delMeta.run(id);
        delBlocks.run(id);
        map.delete(path);
      }
    })();
    this.graphs.delete(collection);
    this.applyScope(collection);
  }

  blocks(source: string): Block[] {
    const rows = this.db
      .prepare(`SELECT heading_path, headings, level, start, end FROM trova_blocks WHERE source_id = ? ORDER BY start`)
      .all(source) as { heading_path: string; headings: string; level: number; start: number; end: number }[];
    return rows.map((r) => ({ headingPath: r.heading_path, headings: JSON.parse(r.headings) as string[], level: r.level, start: r.start, end: r.end }));
  }

  /** The link graph of a collection. Resolved links are written onto each entry. */
  graph(collection: string): CollectionGraph {
    let g = this.graphs.get(collection);
    if (g) return g;
    const map = this.entries(collection);
    const resolve = createLinkResolver(map.keys());
    const inbound = new Map<string, number>();
    for (const e of map.values()) {
      const links = new Set<string>();
      for (const raw of e.rawLinks) {
        const target = resolve(raw, e.path);
        if (target && target !== e.path) links.add(target);
      }
      e.links = [...links];
      for (const l of links) inbound.set(l, (inbound.get(l) ?? 0) + 1);
    }
    g = { resolve, inbound };
    this.graphs.set(collection, g);
    return g;
  }

  isOrphan(collection: string, path: string): boolean {
    const g = this.graph(collection);
    const e = this.entry(collection, path);
    return !!e && e.links.length === 0 && !g.inbound.get(path);
  }

  // ---------- renames ----------

  recordRename(oldId: string, newId: string): void {
    this.db.prepare(`INSERT INTO trova_paths (old_id, new_id, at) VALUES (?, ?, ?)`).run(oldId, newId, Date.now());
  }

  /** Follows the rename history from an old source id to its current id. */
  currentId(sourceId: string): string {
    let id = sourceId;
    const stmt = this.db.prepare(`SELECT new_id FROM trova_paths WHERE old_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`);
    for (let i = 0; i < 20; i++) {
      const row = stmt.get(id) as { new_id: string } | undefined;
      if (!row || row.new_id === id) break;
      id = row.new_id;
    }
    return id;
  }

  renameHistory(): { old_id: string; new_id: string; at: number }[] {
    return this.db.prepare(`SELECT old_id, new_id, at FROM trova_paths ORDER BY at`).all() as { old_id: string; new_id: string; at: number }[];
  }

  // ---------- jobs ----------

  saveJob(job: JobInfo): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO trova_jobs (job_id, kind, state, done, total, error, started, finished) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.jobId, job.kind, job.state, job.done, job.total, job.error ?? null, job.started ?? null, job.finished ?? null);
  }

  // ---------- attachments ----------

  attachmentManifest(collection: string): Map<string, { mtime: number; size: number; pushed: boolean }> {
    const rows = this.db.prepare(`SELECT path, mtime, size, pushed FROM trova_attachments WHERE collection = ?`).all(collection) as {
      path: string;
      mtime: number;
      size: number;
      pushed: number;
    }[];
    return new Map(rows.map((r) => [r.path, { mtime: r.mtime, size: r.size, pushed: r.pushed === 1 }]));
  }

  putAttachment(collection: string, path: string, mtime: number, size: number, pushed: boolean): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO trova_attachments (collection, path, mtime, size, pushed) VALUES (?, ?, ?, ?, ?)`)
      .run(collection, path, Math.round(mtime), size, pushed ? 1 : 0);
  }

  removeAttachment(collection: string, path: string): void {
    this.db.prepare(`DELETE FROM trova_attachments WHERE collection = ? AND path = ?`).run(collection, path);
  }

  // ---------- key-value ----------

  getValue<T>(key: string): T | null {
    const row = this.db.prepare(`SELECT value FROM trova_kv WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setValue(key: string, value: unknown): void {
    this.db.prepare(`INSERT OR REPLACE INTO trova_kv (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
  }
}

export { splitBlocks };
