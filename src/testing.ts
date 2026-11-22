// Deterministic stand-ins for the models, used by tests and by `trova eval --perf`. They need no
// download and give stable vectors: texts that share words get a high cosine similarity.

import { lightStem, type Lane } from "./contract/index.js";
import type { DeepModels, Embedder } from "./backend.js";

const STOP = new Set(
  "the a an and or of to in is it for on with as at by be this that are was from".split(" "),
);

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A bag-of-words hashing embedder. */
export function hashEmbedder(dims = 96, id = "hash-embedder"): Embedder {
  return {
    id,
    dims,
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(dims);
      for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (STOP.has(raw) || raw.length < 2) continue;
        const word = lightStem(raw);
        const h = hash(word);
        vec[h % dims]! += 1;
        vec[(h >>> 8) % dims]! += 0.5;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm === 0) {
        vec[0] = 1;
        return vec;
      }
      for (let i = 0; i < dims; i++) vec[i]! /= norm;
      return vec;
    },
  };
}

/** Expansion and rerank stand-ins: rerank scores by the share of query words a document contains. */
export function fakeDeep(delayMs = 0): DeepModels {
  const words = (t: string) =>
    new Set(
      (t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(lightStem),
    );
  return {
    async expand(query: string): Promise<{ type: Lane; query: string }[]> {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return [
        { type: "lex", query: query.split(/\s+/).slice(0, 3).join(" ") },
        { type: "vec", query: `notes about ${query}` },
      ];
    },
    async rerank(
      query: string,
      docs: { id: string; text: string }[],
    ): Promise<Map<string, number>> {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const q = words(query);
      const out = new Map<string, number>();
      for (const d of docs) {
        const w = words(d.text);
        let hit = 0;
        for (const t of q) if (w.has(t)) hit++;
        out.set(d.id, q.size ? hit / q.size : 0);
      }
      return out;
    },
  };
}
