// A second, read-only connection to qmd.sqlite with sqlite-vec loaded. It serves the three things
// qmd's library does not expose: nearest neighbours of stored vectors, the FTS vocabulary, and
// chunk offsets. It also runs structured FTS5 queries so the lex lane honours ParsedQuery exactly.
//
// Everything here depends on qmd's schema (qmd 2.9.0): documents, content, content_vectors,
// documents_fts, and the vectors partitioned by collection (vectors_by_collection, whose rowid is
// the id of a vector_rows row naming its chunk and collection, and vector_collection_ids). The
// engine checks this layout when it opens the index (`schemaProblems`), and
// test/qmd-contract.test.ts lists every qmd internal the engine relies on; run it first after
// changing the pinned qmd version.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { QMD_BM25_WEIGHTS, type ParsedQuery, type Term, type VocabEntry } from "./contract/index.js";

export interface DocRow {
  id: number;
  collection: string;
  path: string;
  title: string;
  hash: string;
  created_at: string;
  modified_at: string;
}

export interface LexRow extends DocRow {
  score: number;
}

export interface ChunkRow {
  hash: string;
  seq: number;
  pos: number;
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Tokens of a term as FTS5's unicode61 tokenizer would split them; CJK runs split per character, as qmd indexes them. */
function ftsTokens(text: string): string[] {
  return text
    .replace(CJK_RUN, (run) => ` ${Array.from(run).join(" ")} `)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function ftsTerm(term: Term): string | null {
  const tokens = ftsTokens(term.text);
  if (tokens.length === 0) return null;
  const phrase = `"${tokens.join(" ")}"`;
  const prefix = term.kind === "word" && !CJK_CHAR.test(tokens[tokens.length - 1]!) ? "*" : "";
  const scoped = term.field === "title" ? `{filepath title} : ${phrase}${prefix}` : `${phrase}${prefix}`;
  return scoped;
}

/** Builds an FTS5 MATCH expression from a parsed query; null when the query has no positive term. */
export function buildFtsQuery(q: ParsedQuery): string | null {
  const groups: string[] = [];
  for (const group of q.must) {
    const parts = group.map(ftsTerm).filter((p): p is string => p !== null);
    if (parts.length === 0) continue;
    groups.push(parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`);
  }
  if (groups.length === 0) return null;
  let expr = groups.join(" AND ");
  const negatives = q.mustNot.map(ftsTerm).filter((p): p is string => p !== null);
  for (const n of negatives) expr = `(${expr}) NOT ${n}`;
  return expr;
}

/** qmd's vec0 table: one row per chunk and collection, partitioned by an integer collection id. */
const VEC_TABLE = "vectors_by_collection";

/**
 * The tables and columns this reader relies on. qmd creates all of them with the index, except the
 * vec0 table, which appears at the first embedding run. documents_fts must keep this column order,
 * because QMD_BM25_WEIGHTS apply to its columns by position.
 */
const SCHEMA: Record<string, string[]> = {
  documents: ["id", "collection", "path", "title", "hash", "created_at", "modified_at", "active"],
  content: ["hash", "doc"],
  content_vectors: ["hash", "seq", "pos", "model"],
  documents_fts: ["filepath", "title", "body"],
  vector_rows: ["id", "hash", "seq", "collection_id"],
  vector_collection_ids: ["id", "name"],
};
/** sqlite-vec's largest k for one nearest-neighbour scan. */
const MAX_K = 4096;

export class QmdReader {
  private db: Database.Database;
  private vecLoaded = false;
  private vocabReady = false;
  private stmts = new Map<string, Database.Statement>();

  constructor(public readonly dbPath: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
    try {
      sqliteVec.load(this.db);
      this.vecLoaded = true;
    } catch {
      this.vecLoaded = false;
    }
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private placeholders(n: number): string {
    return Array.from({ length: n }, () => "?").join(",");
  }

  /**
   * What is missing from the index for this reader, one line each; empty when the layout matches.
   * A mismatch means the installed qmd and this engine build disagree, so the engine refuses to
   * open rather than show no results.
   */
  schemaProblems(): string[] {
    const problems: string[] = [];
    const columnsOf = this.db.prepare(`SELECT name FROM pragma_table_info(?)`);
    for (const [table, wanted] of Object.entries(SCHEMA)) {
      const have = (columnsOf.all(table) as { name: string }[]).map((r) => r.name);
      if (have.length === 0) problems.push(`table ${table} is missing`);
      else if (table === "documents_fts" && have.join(",") !== wanted.join(",")) problems.push(`documents_fts has columns ${have.join(", ")}, not ${wanted.join(", ")}`);
      else for (const column of wanted) if (!have.includes(column)) problems.push(`column ${table}.${column} is missing`);
    }
    // The vec0 table is described by its definition, which needs no sqlite-vec to read.
    const vec = this.stmt(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${VEC_TABLE}'`).get() as { sql: string } | undefined;
    if (vec && !(/collection_id\s+INTEGER\s+PARTITION KEY/i.test(vec.sql) && /embedding\s+float\[\d+\]/i.test(vec.sql))) {
      problems.push(`${VEC_TABLE} is not partitioned by collection_id with an embedding column`);
    }
    return problems;
  }

  hasVectors(): boolean {
    if (!this.vecLoaded) return false;
    return !!this.stmt(`SELECT name FROM sqlite_master WHERE type='table' AND name='${VEC_TABLE}'`).get();
  }

  /** Embedding dimensions, read from the vec0 table definition. */
  dims(): number | null {
    const row = this.stmt(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${VEC_TABLE}'`).get() as { sql: string } | undefined;
    const m = row ? /float\[(\d+)\]/.exec(row.sql) : null;
    return m ? Number(m[1]) : null;
  }

  // ---------- documents ----------

  activeDocs(collection: string): DocRow[] {
    return this.stmt(
      `SELECT id, collection, path, title, hash, created_at, modified_at FROM documents WHERE collection = ? AND active = 1`,
    ).all(collection) as DocRow[];
  }

  doc(collection: string, path: string): DocRow | undefined {
    return this.stmt(
      `SELECT id, collection, path, title, hash, created_at, modified_at FROM documents WHERE collection = ? AND path = ? AND active = 1`,
    ).get(collection, path) as DocRow | undefined;
  }

  content(hash: string): string | null {
    const row = this.stmt(`SELECT doc FROM content WHERE hash = ?`).get(hash) as { doc: string } | undefined;
    return row ? row.doc : null;
  }

  docsByHashes(hashes: string[]): Map<string, DocRow[]> {
    const out = new Map<string, DocRow[]>();
    for (let i = 0; i < hashes.length; i += 400) {
      const part = hashes.slice(i, i + 400);
      const rows = this.db
        .prepare(
          `SELECT id, collection, path, title, hash, created_at, modified_at FROM documents WHERE active = 1 AND hash IN (${this.placeholders(part.length)})`,
        )
        .all(...part) as DocRow[];
      for (const r of rows) {
        const list = out.get(r.hash);
        if (list) list.push(r);
        else out.set(r.hash, [r]);
      }
    }
    return out;
  }

  counts(collection: string): { sources: number; embedded: number } {
    const sources = (this.stmt(`SELECT COUNT(*) AS n FROM documents WHERE collection = ? AND active = 1`).get(collection) as { n: number }).n;
    const embedded = (
      this.stmt(
        `SELECT COUNT(*) AS n FROM documents d WHERE d.collection = ? AND d.active = 1 AND EXISTS (SELECT 1 FROM content_vectors cv WHERE cv.hash = d.hash)`,
      ).get(collection) as { n: number }
    ).n;
    return { sources, embedded };
  }

  /** Model ids that stored vectors were made with, most common first. */
  vectorModels(): { model: string; chunks: number }[] {
    return this.stmt(`SELECT model, COUNT(*) AS chunks FROM content_vectors GROUP BY model ORDER BY chunks DESC`).all() as {
      model: string;
      chunks: number;
    }[];
  }

  // ---------- lex ----------

  lex(match: string, collections: string[], limit: number): LexRow[] {
    if (collections.length === 0) return [];
    const { path, title, body } = QMD_BM25_WEIGHTS;
    const sql = `
      SELECT d.id, d.collection, d.path, d.title, d.hash, d.created_at, d.modified_at,
             bm25(documents_fts, ${path}, ${title}, ${body}) AS score
      FROM documents_fts
      JOIN documents d ON d.id = documents_fts.rowid
      WHERE documents_fts MATCH ? AND d.active = 1 AND d.collection IN (${this.placeholders(collections.length)})
      ORDER BY score LIMIT ?`;
    try {
      return (this.db.prepare(sql).all(match, ...collections, limit) as LexRow[]).map((r) => ({ ...r, score: -r.score }));
    } catch (err) {
      // A term the tokenizer cannot handle makes FTS5 throw a syntax error; treat it as no match.
      if (String((err as Error).message).includes("fts5")) return [];
      throw err;
    }
  }

  /** True when some indexed term starts with this word (after FTS tokenising and stemming). */
  hasPrefix(word: string): boolean {
    const tokens = ftsTokens(word);
    if (tokens.length === 0) return true;
    try {
      return !!this.stmt(`SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? LIMIT 1`).get(`"${tokens.join(" ")}"*`);
    } catch {
      return true;
    }
  }

  /** The FTS vocabulary with document counts, read through an fts5vocab table. */
  vocabulary(): VocabEntry[] {
    if (!this.vocabReady) {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.trova_vocab USING fts5vocab('main', 'documents_fts', 'row')`);
      this.vocabReady = true;
    }
    return this.stmt(`SELECT term, doc AS docs FROM temp.trova_vocab`).all() as VocabEntry[];
  }

  // ---------- vectors ----------

  chunks(hash: string): ChunkRow[] {
    return this.stmt(`SELECT hash, seq, pos FROM content_vectors WHERE hash = ? ORDER BY seq`).all(hash) as ChunkRow[];
  }

  chunksFor(hashes: string[]): Map<string, ChunkRow[]> {
    const out = new Map<string, ChunkRow[]>();
    for (let i = 0; i < hashes.length; i += 400) {
      const part = hashes.slice(i, i + 400);
      const rows = this.db
        .prepare(`SELECT hash, seq, pos FROM content_vectors WHERE hash IN (${this.placeholders(part.length)}) ORDER BY hash, seq`)
        .all(...part) as ChunkRow[];
      for (const r of rows) {
        const list = out.get(r.hash);
        if (list) list.push(r);
        else out.set(r.hash, [r]);
      }
    }
    return out;
  }

  private toVector(blob: Buffer | Uint8Array): Float32Array {
    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);
    return new Float32Array(copy.buffer);
  }

  /**
   * Stored vectors by `hash_seq` key. A chunk held by several collections is stored once in each,
   * with the same vector, so any one of its rows serves.
   */
  vectors(keys: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    if (!this.hasVectors() || keys.length === 0) return out;
    const wanted = new Set(keys);
    const hashes = [...new Set(keys.map((k) => k.slice(0, k.lastIndexOf("_"))))];
    const vectorOf = this.stmt(`SELECT embedding FROM ${VEC_TABLE} WHERE rowid = ?`);
    for (let i = 0; i < hashes.length; i += 400) {
      const part = hashes.slice(i, i + 400);
      const rows = this.stmt(`SELECT MIN(id) AS id, hash, seq FROM vector_rows WHERE hash IN (${this.placeholders(part.length)}) GROUP BY hash, seq`).all(...part) as {
        id: number;
        hash: string;
        seq: number;
      }[];
      for (const r of rows) {
        const key = `${r.hash}_${r.seq}`;
        if (!wanted.has(key)) continue;
        const row = vectorOf.get(BigInt(r.id)) as { embedding: Buffer } | undefined;
        if (row) out.set(key, this.toVector(row.embedding));
      }
    }
    return out;
  }

  /**
   * The k nearest stored chunks to a vector, with cosine similarity, in the given qmd collections
   * or in all of them. Each collection is scanned on its own, as qmd does, so a small collection is
   * never crowded out by a large one; a chunk held by several collections counts once.
   */
  knn(vector: Float32Array, k: number, collections?: string[]): { hash: string; seq: number; similarity: number }[] {
    if (!this.hasVectors()) return [];
    const ids = collections
      ? collections.length === 0
        ? []
        : (this.stmt(`SELECT id FROM vector_collection_ids WHERE name IN (${this.placeholders(collections.length)})`).all(...collections) as { id: number }[])
      : (this.stmt(`SELECT id FROM vector_collection_ids`).all() as { id: number }[]);
    const embedding = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const kk = Math.max(1, Math.min(MAX_K, Math.floor(k)));
    const scan = this.stmt(`SELECT rowid, distance FROM ${VEC_TABLE} WHERE embedding MATCH ? AND k = ? AND collection_id = ?`);
    const chunkOf = this.stmt(`SELECT hash, seq FROM vector_rows WHERE id = ?`);
    const best = new Map<string, { hash: string; seq: number; similarity: number }>();
    for (const { id } of ids) {
      for (const r of scan.all(embedding, kk, BigInt(id)) as { rowid: number; distance: number }[]) {
        const chunk = chunkOf.get(r.rowid) as { hash: string; seq: number } | undefined;
        if (!chunk) continue;
        const key = `${chunk.hash}_${chunk.seq}`;
        const similarity = 1 - r.distance;
        if ((best.get(key)?.similarity ?? -Infinity) < similarity) best.set(key, { hash: chunk.hash, seq: chunk.seq, similarity });
      }
    }
    return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, kk);
  }

  /** Iterates every stored chunk vector of the given collections' active documents. */
  allChunkKeys(collections: string[]): ChunkRow[] {
    if (collections.length === 0) return [];
    return this.db
      .prepare(
        `SELECT DISTINCT cv.hash, cv.seq, cv.pos FROM content_vectors cv JOIN documents d ON d.hash = cv.hash AND d.active = 1
         WHERE d.collection IN (${this.placeholders(collections.length)}) ORDER BY cv.hash, cv.seq`,
      )
      .all(...collections) as ChunkRow[];
  }
}
