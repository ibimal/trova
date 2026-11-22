// The evaluation harness behind `trova eval`: nDCG@10 for Instant search and Ask, Recall@20 for
// Connections, and latency percentiles for the engine-side rows of the Budgets table.

import { readFileSync } from "node:fs";
import {
  ndcg,
  parseQuery,
  recallAt,
  type RelatedResponse,
  type Result,
  type ResultBatch,
} from "../contract/index.js";
import type { EvalQuery } from "./fixture.js";

export * from "./fixture.js";

/** The part of the engine client that the harness needs. */
export interface EvalClient {
  json<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
  stream(path: string, body: unknown): AsyncIterable<ResultBatch>;
}

export interface EvalRow {
  group: string;
  metric: string;
  queries: number;
  value: number;
}

export interface EvalReport {
  rows: EvalRow[];
  perQuery: { id: string; surface: string; shape: string; metric: string; value: number }[];
}

export function loadQueries(file: string): EvalQuery[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

async function finalResults(stream: AsyncIterable<ResultBatch>): Promise<Result[]> {
  let last: Result[] = [];
  for await (const b of stream)
    if (b.results.length > 0 || b.final) last = b.results.length ? b.results : last;
  return last;
}

/** Relevance labels may name a source path, a source id or a block id. Results are matched on all three. */
function rankedKeys(results: Result[], relevant: Record<string, number>): string[] {
  const out: string[] = [];
  for (const r of results) {
    const key = [r.id, r.source, r.path].find((k) => k in relevant) ?? r.id;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export async function runEval(
  client: EvalClient,
  queries: EvalQuery[],
  collection?: string,
): Promise<EvalReport> {
  const collections = collection ? [collection] : undefined;
  const perQuery: EvalReport["perQuery"] = [];
  for (const q of queries) {
    if (q.surface === "related") {
      if (!q.anchor) continue;
      const doc = await client.json<{ id: string }>("POST", "/v1/documents/get", {
        id: q.anchor,
        collection,
      });
      const res = await client.json<RelatedResponse>("POST", "/v1/related", {
        anchor: { source: doc.id },
        limit: 20,
        collections,
        loose: true,
        granularity: "source",
      });
      perQuery.push({
        id: q.id,
        surface: q.surface,
        shape: q.shape,
        metric: "recall@20",
        value: recallAt(rankedKeys(res.results, q.relevant), q.relevant, 20),
      });
      continue;
    }
    const parsed = parseQuery(q.query, { mode: q.surface === "ask" ? "ask" : "instant" }).query;
    const results =
      q.surface === "ask"
        ? await finalResults(
            client.stream("/v1/ask", { query: parsed, mode: "auto", collections, limit: 20 }),
          )
        : await finalResults(
            client.stream("/v1/search", { query: parsed, lanes: ["lex"], collections, limit: 20 }),
          );
    perQuery.push({
      id: q.id,
      surface: q.surface,
      shape: q.shape,
      metric: "ndcg@10",
      value: ndcg(rankedKeys(results, q.relevant), q.relevant, 10),
    });
  }
  const groups = new Map<string, { metric: string; values: number[] }>();
  for (const p of perQuery) {
    const key = `${p.surface} / ${p.shape}`;
    const g = groups.get(key) ?? { metric: p.metric, values: [] };
    g.values.push(p.value);
    groups.set(key, g);
  }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, g]) => ({
      group,
      metric: g.metric,
      queries: g.values.length,
      value: g.values.reduce((a, b) => a + b, 0) / g.values.length,
    }));
  return { rows, perQuery };
}

export interface PerfRow {
  interaction: string;
  p50: number;
  p95: number;
  targetP50: number;
  targetP95: number;
  runs: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function time(
  runs: number,
  fn: (i: number) => Promise<unknown>,
): Promise<{ p50: number; p95: number }> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn(i);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 0.5), p95: percentile(times, 0.95) };
}

async function drain(stream: AsyncIterable<ResultBatch>): Promise<void> {
  for await (const _ of stream) void _;
}

/** Measures the engine-side budgets. The paint-time budgets need Obsidian and are not covered. */
export async function runPerf(
  client: EvalClient,
  collection: string,
  anchors: string[],
  terms: string[],
  runs = 60,
): Promise<PerfRow[]> {
  const collections = [collection];
  const word = (i: number) => terms[i % terms.length]!;
  const q = (raw: string, mode: "instant" | "ask" = "instant") => parseQuery(raw, { mode }).query;
  const rows: PerfRow[] = [];
  const add = (
    interaction: string,
    t: { p50: number; p95: number },
    targetP50: number,
    targetP95: number,
  ) => rows.push({ interaction, ...t, targetP50, targetP95, runs });
  add(
    "Lex lane (engine part of keystroke to first rows)",
    await time(runs, (i) =>
      drain(
        client.stream("/v1/search", {
          query: q(`${word(i)} ${word(i + 3)}`),
          lanes: ["lex"],
          collections,
          limit: 20,
          fuzzy: false,
        }),
      ),
    ),
    15,
    30,
  );
  add(
    "Lex lane with typo rescue",
    await time(runs, (i) =>
      drain(
        client.stream("/v1/search", {
          query: q(`${word(i).slice(0, -1)}x`),
          lanes: ["lex"],
          collections,
          limit: 20,
          fuzzy: true,
        }),
      ),
    ),
    25,
    55,
  );
  add(
    "Vec lane (semantic rows)",
    await time(runs, (i) =>
      drain(
        client.stream("/v1/search", {
          query: q(`${word(i)} ${word(i + 1)} ${word(i + 2)}`),
          lanes: ["vec"],
          collections,
          limit: 5,
        }),
      ),
    ),
    120,
    250,
  );
  const ids: string[] = [];
  for (const a of anchors)
    ids.push(
      (await client.json<{ id: string }>("POST", "/v1/documents/get", { id: a, collection })).id,
    );
  add(
    "Connections, uncached",
    await time(runs, (i) =>
      client.json("POST", "/v1/related", {
        anchor: { source: ids[i % ids.length] },
        limit: 20,
        collections,
      }),
    ),
    150,
    400,
  );
  add(
    "Ask, fast",
    await time(runs, (i) =>
      drain(
        client.stream("/v1/ask", {
          query: q(`${word(i)} ${word(i + 2)}`, "ask"),
          mode: "fast",
          collections,
        }),
      ),
    ),
    150,
    350,
  );
  return rows;
}
