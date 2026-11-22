// Background analysis for Vault care: near-duplicates and the topic map. Both run as jobs at the
// lowest priority and pause between sources while an interactive request is in flight.

import {
  DUPLICATE_BLOCK_COSINE,
  DUPLICATE_BLOCK_MIN_WORDS,
  DUPLICATE_SOURCE_COSINE,
  blockAt,
  blockId,
  blockText,
  cosine,
  countWords,
  meanVector,
  sourceId,
  type Block,
  type DuplicatePair,
  type TopicCluster,
} from "./contract/index.js";
import type { JobCtx } from "./jobs.js";
import type { ChunkRow, QmdReader } from "./reader.js";
import { publicPath, type MetaEntry } from "./sidecar.js";

export interface AnalysisInput {
  reader: QmdReader;
  collections: {
    name: string;
    qmdNames: string[];
    entries: Map<string, MetaEntry>;
    blocks: (source: string) => Block[];
  }[];
}

interface Doc {
  collection: string;
  entry: MetaEntry;
  source: string;
}

function docIndex(input: AnalysisInput): { byHash: Map<string, Doc[]>; docs: Doc[] } {
  const byHash = new Map<string, Doc[]>();
  const docs: Doc[] = [];
  for (const c of input.collections) {
    for (const entry of c.entries.values()) {
      if (entry.excluded) continue;
      const doc = { collection: c.name, entry, source: sourceId(c.name, entry.path) };
      docs.push(doc);
      const list = byHash.get(entry.hash);
      if (list) list.push(doc);
      else byHash.set(entry.hash, [doc]);
    }
  }
  return { byHash, docs };
}

function chunksOverlapping(chunks: ChunkRow[], block: Block, length: number): ChunkRow[] {
  const hit = chunks.filter((c, i) => {
    const end = i + 1 < chunks.length ? chunks[i + 1]!.pos : length;
    return c.pos < block.end && Math.max(end, c.pos + 1) > block.start;
  });
  return hit.length ? hit : chunks.slice(-1);
}

export async function findDuplicates(input: AnalysisInput, ctx: JobCtx): Promise<DuplicatePair[]> {
  const { reader } = input;
  const { byHash, docs } = docIndex(input);
  const blocksOf = (doc: Doc) => input.collections.find((c) => c.name === doc.collection)!.blocks(doc.source);
  const pairs = new Map<string, DuplicatePair>();
  const sourcePairs = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const noteVecs = new Map<string, Float32Array | null>();
  const noteVec = (hash: string): Float32Array | null => {
    if (!noteVecs.has(hash)) {
      const keys = reader.chunks(hash).map((c) => `${c.hash}_${c.seq}`);
      noteVecs.set(hash, meanVector([...reader.vectors(keys).values()]));
      if (noteVecs.size > 2000) noteVecs.delete(noteVecs.keys().next().value!);
    }
    return noteVecs.get(hash) ?? null;
  };
  const addPair = (a: Doc, b: Doc, kind: "block" | "source", similarity: number, aId = a.source, bId = b.source) => {
    const key = pairKey(aId, bId);
    if (pairs.has(key)) return;
    pairs.set(key, { a: aId, b: bId, aTitle: a.entry.title, bTitle: b.entry.title, aPath: a.entry.path, bPath: b.entry.path, kind, similarity });
  };

  // Identical text under two paths is a duplicate without any vector work.
  for (const list of byHash.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        addPair(list[i]!, list[j]!, "source", 1);
        sourcePairs.add(pairKey(list[i]!.source, list[j]!.source));
      }
    }
  }

  const seenHash = new Set<string>();
  let done = 0;
  for (const doc of docs) {
    ctx.progress(++done, docs.length, { stage: "duplicates" });
    if (ctx.cancelled()) return [];
    if (seenHash.has(doc.entry.hash)) continue;
    seenHash.add(doc.entry.hash);
    await ctx.pause();
    const chunks = reader.chunks(doc.entry.hash);
    if (chunks.length === 0) continue;
    const text = reader.content(doc.entry.hash) ?? "";
    const vectors = reader.vectors(chunks.map((c) => `${c.hash}_${c.seq}`));
    const whole = meanVector([...vectors.values()]);
    if (!whole) continue;

    // Source pairs: note vectors at or above the source threshold.
    for (const n of reader.knn(whole, 8)) {
      if (n.hash === doc.entry.hash || n.similarity < DUPLICATE_SOURCE_COSINE - 0.1) continue;
      const other = noteVec(n.hash);
      if (!other) continue;
      const sim = cosine(whole, other);
      if (sim < DUPLICATE_SOURCE_COSINE) continue;
      for (const o of byHash.get(n.hash) ?? []) {
        addPair(doc, o, "source", sim);
        sourcePairs.add(pairKey(doc.source, o.source));
      }
    }

    // Block pairs: blocks of at least 40 words. Blocks that share one chunk set share a vector, so each set is checked once.
    const signatures = new Set<string>();
    for (const block of blocksOf(doc)) {
      if (countWords(blockText(text, block)) < DUPLICATE_BLOCK_MIN_WORDS) continue;
      const own = chunksOverlapping(chunks, block, text.length);
      const signature = own.map((c) => c.seq).join(",");
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      const vec = meanVector(own.map((c) => vectors.get(`${c.hash}_${c.seq}`)).filter((v): v is Float32Array => !!v));
      if (!vec) continue;
      for (const n of reader.knn(vec, 8)) {
        if (n.hash === doc.entry.hash || n.similarity < DUPLICATE_BLOCK_COSINE - 0.1) continue;
        for (const o of byHash.get(n.hash) ?? []) {
          if (sourcePairs.has(pairKey(doc.source, o.source))) continue;
          const oChunks = reader.chunks(n.hash);
          const pos = oChunks.find((c) => c.seq === n.seq)?.pos ?? 0;
          const oText = reader.content(n.hash) ?? "";
          const oBlock = blockAt(blocksOf(o), pos);
          if (!oBlock || countWords(blockText(oText, oBlock)) < DUPLICATE_BLOCK_MIN_WORDS) continue;
          const oOwn = chunksOverlapping(oChunks, oBlock, oText.length);
          const oVec = meanVector([...reader.vectors(oOwn.map((c) => `${c.hash}_${c.seq}`)).values()]);
          if (!oVec) continue;
          const sim = cosine(vec, oVec);
          if (sim >= DUPLICATE_BLOCK_COSINE) addPair(doc, o, "block", sim, blockId(doc.source, block.headingPath), blockId(o.source, oBlock.headingPath));
        }
      }
    }
  }
  return [...pairs.values()].sort((a, b) => b.similarity - a.similarity);
}

// ---------- topic map ----------

/** A small seeded generator, so the same vault gives the same map. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

const TOPIC_STOP = new Set("the and for with from that this notes note about into your what when how why are was not but all new one two use using".split(" "));

export async function findTopics(input: AnalysisInput, ctx: JobCtx): Promise<TopicCluster[]> {
  const { reader } = input;
  const { docs } = docIndex(input);
  const items: { doc: Doc; vec: Float32Array }[] = [];
  let done = 0;
  for (const doc of docs) {
    if (ctx.cancelled()) return [];
    if (++done % 200 === 0) {
      ctx.progress(done, docs.length * 2, { stage: "topics" });
      await ctx.pause();
    }
    const keys = reader.chunks(doc.entry.hash).map((c) => `${c.hash}_${c.seq}`);
    const vec = meanVector([...reader.vectors(keys).values()]);
    if (vec) items.push({ doc, vec });
  }
  const n = items.length;
  if (n < 2) return [];
  const dims = items[0]!.vec.length;
  const k = Math.max(2, Math.min(24, Math.round(Math.sqrt(n / 2))));
  const random = rng(n * 31 + dims);

  // k-means++ seeding, then Lloyd iterations on cosine similarity.
  const centroids: Float32Array[] = [items[Math.floor(random() * n)]!.vec.slice()];
  const dist = new Float64Array(n).fill(Infinity);
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1]!;
    let total = 0;
    for (let i = 0; i < n; i++) {
      dist[i] = Math.min(dist[i]!, Math.max(0, 1 - dot(items[i]!.vec, last)));
      total += dist[i]!;
    }
    let pick = random() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      pick -= dist[i]!;
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(items[chosen]!.vec.slice());
  }
  const assign = new Int32Array(n);
  for (let iter = 0; iter < 12; iter++) {
    if (ctx.cancelled()) return [];
    await ctx.pause();
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = dot(items[i]!.vec, centroids[c]!);
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
    }
    for (let c = 0; c < k; c++) {
      const members = items.filter((_, i) => assign[i] === c).map((it) => it.vec);
      const mean = meanVector(members);
      if (mean) centroids[c] = mean;
    }
    ctx.progress(docs.length + Math.round(((iter + 1) / 12) * docs.length), docs.length * 2, { stage: "topics" });
    if (moved === 0 && iter > 0) break;
  }

  // Two principal components by power iteration, for the 2D layout.
  const mean = new Float32Array(dims);
  for (const it of items) for (let d = 0; d < dims; d++) mean[d]! += it.vec[d]! / n;
  const component = (ortho: Float32Array | null): Float32Array => {
    let v = new Float32Array(dims);
    for (let d = 0; d < dims; d++) v[d] = random() - 0.5;
    for (let iter = 0; iter < 20; iter++) {
      const next = new Float32Array(dims);
      for (const it of items) {
        let proj = 0;
        for (let d = 0; d < dims; d++) proj += (it.vec[d]! - mean[d]!) * v[d]!;
        for (let d = 0; d < dims; d++) next[d]! += proj * (it.vec[d]! - mean[d]!);
      }
      if (ortho) {
        const o = dot(next, ortho);
        for (let d = 0; d < dims; d++) next[d]! -= o * ortho[d]!;
      }
      const norm = Math.sqrt(dot(next, next)) || 1;
      for (let d = 0; d < dims; d++) next[d]! /= norm;
      v = next;
    }
    return v;
  };
  const pc1 = component(null);
  await ctx.pause();
  const pc2 = component(pc1);
  const project = (vec: Float32Array): [number, number] => {
    let x = 0;
    let y = 0;
    for (let d = 0; d < dims; d++) {
      const centred = vec[d]! - mean[d]!;
      x += centred * pc1[d]!;
      y += centred * pc2[d]!;
    }
    return [x, y];
  };
  const points = items.map((it) => project(it.vec));
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = (v: number, lo: number, hi: number) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));

  // Labels: the terms most specific to each cluster, from titles, headings and tags.
  const termsOf = (it: { doc: Doc }): string[] => {
    const c = input.collections.find((col) => col.name === it.doc.collection)!;
    const headings = c.blocks(it.doc.source).flatMap((b) => b.headings.slice(-1));
    const text = [it.doc.entry.title, publicPath(it.doc.entry.qmdCollection, it.doc.entry.qmdPath).split("/").slice(0, -1).join(" "), ...headings, ...it.doc.entry.tags].join(" ");
    return [...new Set((text.toLowerCase().match(/[\p{L}][\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !TOPIC_STOP.has(w)))];
  };
  const tf: Map<string, number>[] = Array.from({ length: k }, () => new Map());
  const df = new Map<string, number>();
  items.forEach((it, i) => {
    for (const t of termsOf(it)) {
      const m = tf[assign[i]!]!;
      if (!m.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
  });

  const clusters: TopicCluster[] = [];
  for (let c = 0; c < k; c++) {
    const members = items.map((it, i) => ({ it, i })).filter(({ i }) => assign[i] === c);
    if (members.length === 0) continue;
    const label = [...tf[c]!.entries()]
      .map(([term, count]) => ({ term, score: count * Math.log(1 + k / (df.get(term) ?? 1)) }))
      .sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
      .slice(0, 3)
      .map((t) => t.term);
    const sources = members.map(({ it, i }) => ({
      id: it.doc.source,
      path: it.doc.entry.path,
      title: it.doc.entry.title,
      x: scale(points[i]![0], minX, maxX),
      y: scale(points[i]![1], minY, maxY),
    }));
    clusters.push({
      id: clusters.length,
      label,
      x: sources.reduce((s, p) => s + p.x, 0) / sources.length,
      y: sources.reduce((s, p) => s + p.y, 0) / sources.length,
      sources,
    });
  }
  return clusters.sort((a, b) => b.sources.length - a.sources.length).map((c, i) => ({ ...c, id: i }));
}
