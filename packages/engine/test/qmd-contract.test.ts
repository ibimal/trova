// The qmd internals this engine relies on beyond qmd's public API: the index layout the reader
// queries, the parts of `store.internal` the backend calls, and llm.js, which qmd does not export.
// Run this file first after changing the pinned qmd version; each failure names one thing to adapt.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { qmdDist } from "../src/backend.js";
import { Engine } from "../src/engine.js";
import { hashEmbedder } from "../src/testing.js";
import { makeEnv, type TestEnv } from "./helpers.js";

interface Internal {
  db: unknown;
  llm?: { embedModelName: unknown; rerankModelName: unknown; generateModelName: unknown; embed: unknown };
  rerank: unknown;
  insertEmbedding: unknown;
  ensureVecTable: unknown;
}

describe("qmd contract", () => {
  let env: TestEnv;
  const store = () => (env.engine as unknown as { backend: { store: { internal: Internal; getStatus(): Promise<{ needsEmbedding: unknown }> } } }).backend.store;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("the index has every table and column the reader queries", () => {
    const reader = (env.engine as unknown as { reader: { schemaProblems(): string[]; hasVectors(): boolean } }).reader;
    expect(reader.hasVectors()).toBe(true);
    expect(reader.schemaProblems()).toEqual([]);
  });

  it("store.internal has the database, the models, rerank, and the embedding writers tests use", () => {
    const internal = store().internal;
    expect(internal.db).toBeDefined();
    expect(typeof internal.rerank).toBe("function");
    expect(typeof internal.insertEmbedding).toBe("function");
    expect(typeof internal.ensureVecTable).toBe("function");
    const llm = internal.llm!;
    for (const name of [llm.embedModelName, llm.rerankModelName, llm.generateModelName]) expect(typeof name === "string" && name.length > 0).toBe(true);
    expect(typeof llm.embed).toBe("function");
  });

  it("getStatus reports the documents waiting to be embedded", async () => {
    expect(typeof (await store().getStatus()).needsEmbedding).toBe("number");
  });

  it("llm.js exports the embedding formats, the model download and the model folder", async () => {
    const llm = (await import(pathToFileURL(join(qmdDist(), "llm.js")).href)) as Record<string, unknown>;
    expect(typeof llm["formatQueryForEmbedding"]).toBe("function");
    expect(typeof llm["formatDocForEmbedding"]).toBe("function");
    expect(typeof llm["pullModels"]).toBe("function");
    expect(typeof llm["DEFAULT_MODEL_CACHE_DIR"]).toBe("string");
  });

  it("qmd still reports a change of vector size as a dimension mismatch, which the backend retries with force", () => {
    expect(readFileSync(join(qmdDist(), "store.js"), "utf8")).toMatch(/Embedding dimension mismatch/);
  });

  // Last, because it changes the shared test index. qmd recreates a missing table when it opens an
  // index but never adds a column to an existing one, so a missing column is what a mismatch looks like.
  it("the engine refuses to open an index without the layout it reads", async () => {
    const db = new Database(join(env.home, "qmd.sqlite"));
    db.exec("ALTER TABLE content_vectors DROP COLUMN pos");
    db.close();
    await expect(Engine.open({ home: env.home, embedder: hashEmbedder() })).rejects.toThrow(/column content_vectors\.pos is missing/);
  });
});
