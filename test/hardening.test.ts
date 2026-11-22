import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { EngineError, blockId, sourceId } from "../src/contract/index.js";
import { isLoopbackRequest } from "../src/mcp.js";
import { dataPaths, writeDaemonInfo } from "../src/paths.js";
import { writeFixtureVault } from "../src/eval/fixture.js";
import { Engine } from "../src/engine.js";
import { fakeDeep, hashEmbedder } from "../src/testing.js";
import { COLLECTION, makeEnv, type TestEnv } from "./helpers.js";
import type { QmdBackend } from "../src/backend.js";

describe("MCP over HTTP accepts only this machine", () => {
  it.each([
    ["127.0.0.1:8181", undefined, true],
    ["localhost:8181", undefined, true],
    ["[::1]:8181", undefined, true],
    ["127.0.0.1:8181", "http://localhost:6274", true],
    ["evil.example:8181", undefined, false],
    ["127.0.0.1:8181", "https://evil.example", false],
    ["127.0.0.1.evil.example:8181", undefined, false],
    [undefined, undefined, false],
    ["127.0.0.1:8181", "not a url", false],
  ] as const)("Host %s, Origin %s → %s", (host, origin, allowed) => {
    expect(isLoopbackRequest(host, origin)).toBe(allowed);
  });
});

describe("data folder and daemon.json", () => {
  it("creates a new data folder for the user only, and rewrites a loose daemon.json with mode 600", () => {
    const root = mkdtempSync(join(tmpdir(), "trova-paths-"));
    try {
      const home = join(root, "home");
      dataPaths(home);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      const file = join(home, "daemon.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o644);
      writeDaemonInfo({ pid: 1, port: 2, token: "t", version: "0", api: "v1" }, home);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("engine input checks", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("refuses pushed image text whose path leaves the collection", () => {
    for (const path of ["../../escape.png", "/tmp/escape.png", "a/../../escape.png"]) {
      expect(() => env.engine.attachmentText({ collection: COLLECTION, path, text: "text" })).toThrow(EngineError);
    }
    expect(existsSync(join(env.home, "escape.png.md"))).toBe(false);
    expect(existsSync(join(env.home, "attachments", "escape.png.md"))).toBe(false);
    expect(() => env.engine.attachmentText({ collection: COLLECTION, path: "Images/ok.png", text: "text" })).not.toThrow();
  });

  it("removing a collection leaves another whose name differs only by _ or letter case", async () => {
    const sidecar = (env.engine as unknown as { sidecar: { blocks(source: string): unknown[]; entries(c: string): Map<string, unknown> } }).sidecar;
    const path = [...sidecar.entries(COLLECTION).keys()].find((p) => sidecar.blocks(sourceId(COLLECTION, p)).length > 0)!;
    const source = sourceId(COLLECTION, path);
    const before = sidecar.blocks(source).length;
    expect(before).toBeGreaterThan(0);
    for (const name of [COLLECTION.replace("-", "_"), COLLECTION.toUpperCase()]) {
      await env.engine.addCollection({ name, path: env.vault, options: { kind: "folder" } });
      env.engine.sync({ collection: name, full: true });
      await env.engine.drain();
      await env.engine.removeCollection(name);
    }
    expect(sidecar.blocks(source).length).toBe(before);
    expect(() => env.engine.get({ id: blockId(source, (sidecar.blocks(source)[0] as { headingPath: string }).headingPath) })).not.toThrow();
  });
});

describe("removing a collection after a restart", () => {
  it("also removes the attachment collection and its text files that an earlier daemon registered", async () => {
    const env = await makeEnv();
    const att = join(env.home, "attachments", COLLECTION);
    expect(existsSync(att)).toBe(true);
    await env.engine.close();
    const engine = await Engine.open({ home: env.home, embedder: hashEmbedder(), deep: fakeDeep() });
    try {
      await engine.removeCollection(COLLECTION);
      const backend = (engine as unknown as { backend: QmdBackend }).backend;
      expect((await backend.listCollections()).map((c) => c.name)).not.toContain(`${COLLECTION}-att`);
      expect(existsSync(att)).toBe(false);
    } finally {
      await engine.close();
      rmSync(join(env.home, ".."), { recursive: true, force: true });
    }
  });
});

describe("vectors partitioned by collection", () => {
  let env: TestEnv;
  const SMALL = "kitchen";
  type Reader = {
    knn(v: Float32Array, k: number, collections?: string[]): { hash: string; seq: number; similarity: number }[];
    vectors(keys: string[]): Map<string, Float32Array>;
    docsByHashes(hashes: string[]): Map<string, { collection: string }[]>;
  };
  const reader = () => (env.engine as unknown as { reader: Reader }).reader;
  beforeAll(async () => {
    env = await makeEnv();
    // A second collection over one folder of the vault: its notes are in both collections.
    await env.engine.addCollection({ name: SMALL, path: join(env.vault, "Kitchen"), options: { kind: "folder" } });
    env.engine.sync({ collection: SMALL, full: true });
    await env.engine.drain();
  });
  afterAll(async () => {
    await env.cleanup();
  });

  const kitchenVector = () => {
    const entries = (env.engine as unknown as { sidecar: { entries(c: string): Map<string, { hash: string }> } }).sidecar.entries(SMALL);
    const hash = [...entries.values()][0]!.hash;
    const vector = reader().vectors([`${hash}_0`]).get(`${hash}_0`);
    expect(vector).toBeDefined();
    return vector!;
  };

  it("a scoped search returns only chunks of that collection", () => {
    const near = reader().knn(kitchenVector(), 10, [SMALL]);
    expect(near.length).toBeGreaterThan(0);
    const docs = reader().docsByHashes(near.map((n) => n.hash));
    for (const n of near) expect(docs.get(n.hash)?.some((d) => d.collection === SMALL)).toBe(true);
    expect(reader().knn(kitchenVector(), 10, [])).toEqual([]);
  });

  it("a search over all collections counts a chunk held by two collections once", () => {
    const near = reader().knn(kitchenVector(), 60);
    const keys = near.map((n) => `${n.hash}_${n.seq}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(near.length).toBeGreaterThan(0);
  });

  it("related notes in the small collection are not crowded out by the vault", async () => {
    const entries = (env.engine as unknown as { sidecar: { entries(c: string): Map<string, { path: string }> } }).sidecar.entries(SMALL);
    const path = [...entries.values()][0]!.path;
    const res = await env.engine.related({ anchor: { source: sourceId(SMALL, path) }, collections: [SMALL], limit: 10 });
    expect(res.anchorIndexed).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.collection === SMALL)).toBe(true);
  });
});

describe("pausing indexing", () => {
  it("stops an embedding run, reports ready only when done, and resumes on Resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "trova-pause-"));
    const fast = hashEmbedder();
    // A slow embedder, so the run is still going when it is paused.
    const embedder = { ...fast, embed: async (text: string, isQuery: boolean) => (await new Promise((r) => setTimeout(r, 4)), fast.embed(text, isQuery)) };
    const engine = await Engine.open({ home: join(root, "home"), embedder, deep: fakeDeep() });
    try {
      writeFixtureVault(join(root, "vault"));
      await engine.addCollection({ name: COLLECTION, path: join(root, "vault"), options: { kind: "vault" } });
      const ready: number[] = [];
      engine.on((e) => e.event === "index.ready" && ready.push(Date.now()));
      engine.sync({ collection: COLLECTION, full: true });
      const backend = (engine as unknown as { backend: { pendingEmbeddings(): Promise<number> } }).backend;
      // Wait until embedding is under way, then pause.
      for (let i = 0; i < 400 && !engine.jobs.active().some((j) => j.kind === "embed" && j.done > 5); i++) await new Promise((r) => setTimeout(r, 10));
      engine.pause();
      await new Promise((r) => setTimeout(r, 300));
      const waiting = await backend.pendingEmbeddings();
      expect(waiting).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(await backend.pendingEmbeddings()).toBe(waiting);
      expect(ready).toEqual([]);
      await engine.resume();
      await engine.drain();
      expect(await backend.pendingEmbeddings()).toBe(0);
      expect(ready.length).toBe(1);
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
