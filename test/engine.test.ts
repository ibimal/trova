import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  API_VERSION,
  EngineError,
  type EngineEvent,
  type ResultBatch,
} from "../src/contract/index.js";
import { startServer, type RunningServer } from "../src/server.js";
import { fakeDeep } from "../src/testing.js";
import { COLLECTION, collect, makeEnv, q, type TestEnv } from "./helpers.js";

let env: TestEnv;
const src = (path: string) => `${COLLECTION}:${path}`;

beforeAll(async () => {
  env = await makeEnv();
}, 120000);
afterAll(() => env.cleanup());

const lex = async (raw: string, extra = {}) =>
  (
    await collect(
      env.engine.search({ query: q(raw), lanes: ["lex"], collections: [COLLECTION], ...extra }),
    )
  )[0]!;
const paths = (b: ResultBatch) => b.results.map((r) => r.path);

describe("index and status", () => {
  it("indexes notes, the canvas and the PDF, and reports counts and capabilities", () => {
    const s = env.engine.status();
    expect(s.api).toBe(API_VERSION);
    expect(s.engine.backend).toMatch(/^qmd \d/);
    const c = s.collections[0]!;
    expect(c.name).toBe(COLLECTION);
    expect(c.sources).toBe(env.fixture.notes.length);
    expect(c.embedded).toBe(c.sources);
    expect(c.pending).toBe(0);
    expect(s.capabilities).toEqual(
      expect.arrayContaining([
        "lex",
        "vec",
        "fuzzy",
        "relatedByVector",
        "blocks",
        "rerank",
        "expansion",
      ]),
    );
    expect(s.models.embed.dims).toBe(96);
    expect(s.jobs).toEqual([]);
  });
});

describe("search, lex lane", () => {
  it("ranks the title match first and returns a block id, snippet and highlights", async () => {
    const b = await lex("kanata");
    expect(b.stage).toBe("lex");
    expect(b.final).toBe(true);
    const top = b.results[0]!;
    expect(top.path).toBe("Tools/Kanata.md");
    expect(top.source).toBe(src("Tools/Kanata.md"));
    expect(top.id.startsWith(`${top.source}#`)).toBe(true);
    expect(top.matchedBy).toEqual(["lex"]);
    expect(top.scores.lex).toBeGreaterThan(0);
    const [a, z] = top.highlights[0]!;
    expect(top.snippet.slice(a, z).toLowerCase()).toContain("kanata");
  });
  it("matches prefixes, ANDs words, and honours phrases, exclusions, exact and OR", async () => {
    expect(paths(await lex("kana"))).toContain("Tools/Kanata.md");
    expect(paths(await lex("kanata homebrew"))).toEqual(["Tools/Kanata.md"]);
    expect(paths(await lex('"input monitoring permission"'))).toEqual(["Tools/Kanata.md"]);
    expect(paths(await lex('"monitoring input permission"'))).toEqual([]);
    expect(paths(await lex("kanata -homebrew"))).not.toContain("Tools/Kanata.md");
    expect(paths(await lex("=lighthous"))).toEqual([]);
    expect(paths(await lex("=lighthouse"))).toEqual(["NoHeadings.md"]);
    const either = paths(await lex("lighthouse OR harbour"));
    expect(either).toEqual(expect.arrayContaining(["NoHeadings.md", "Orphan.md"]));
  });
  it("points at the matched block, numbering repeated headings", async () => {
    const b = await lex("udev rule");
    expect(b.results[0]!.block!.id).toBe(src("Tools/Kanata.md#setup/install~2"));
    expect(b.results[0]!.block!.headings).toEqual(["Setup", "Install"]);
  });
  it("applies filters before ranking", async () => {
    expect(paths(await lex("kanata path:Tools"))).toEqual(["Tools/Kanata.md"]);
    expect(paths(await lex("kanata tag:#keyboard"))).toEqual(["Tools/Kanata.md"]);
    expect(paths(await lex("kanata ext:canvas"))).toEqual(["Board.canvas"]);
    expect(paths(await lex("plan status:active rating:>3 path:Projects"))).toEqual([
      "Projects/Trova/Plan.md",
    ]);
    expect(paths(await lex("kanata links:[[Trova]]"))).toEqual(["Tools/Kanata.md"]);
    expect(paths(await lex("harbour is:orphan"))).toEqual(["Orphan.md"]);
    expect(paths(await lex("kanata is:orphan"))).not.toContain("Tools/Kanata.md");
    expect(paths(await lex("kanata modified:1d")).length).toBeGreaterThan(0);
    expect(paths(await lex("kanata modified:<2020-01-01"))).toEqual([]);
    expect(paths(await lex("in:title kanata"))).toEqual(["Tools/Kanata.md"]);
    expect(paths(await lex("in:heading milestones"))).toEqual(["Projects/Trova/Plan.md"]);
  });
  it("lists sources for a filter-only query", async () => {
    const b = await lex("tag:#planning");
    expect(paths(b)).toEqual(["Projects/Trova/Plan.md"]);
  });
  it("never returns excluded notes or notes outside the scope", async () => {
    expect(paths(await lex("zebrafish"))).toEqual([]);
    expect(paths(await lex("template body"))).not.toContain("Templates/Note.md");
    expect(() => env.engine.get({ id: src("Secret.md") })).toThrowError(EngineError);
  });
  it("rescues typos and reports the correction", async () => {
    const b = await lex("lighthuose");
    expect(b.correction).toEqual({ from: "lighthuose", to: expect.stringMatching(/^lighthous/) });
    expect(paths(b)).toEqual(["NoHeadings.md"]);
    expect(b.results[0]!.matchedBy).toEqual(["fuzzy"]);
    expect((await lex("lighthuose", { fuzzy: false })).results).toEqual([]);
  });
  it("searches attachments: PDF pages and canvas cards", async () => {
    const pdf = (await lex("xylophone")).results[0]!;
    expect(pdf.path).toBe("Papers/Fusion.pdf");
    expect(pdf.type).toBe("pdf");
    expect(pdf.block!.headings).toEqual(["Page 2"]);
    const canvas = (await lex("periscope")).results[0]!;
    expect(canvas.path).toBe("Board.canvas");
    expect(canvas.type).toBe("canvas");
  });
  it("finds non-English text", async () => {
    expect(paths(await lex("Suchmaschine"))).toContain("Sprachen/Suchmaschinen.md");
    expect(paths(await lex("検索エンジン"))).toContain("Sprachen/日本語.md");
  });
});

describe("search, vec lane and streaming", () => {
  it("streams lex then vec, with final on the last line only", async () => {
    const batches = await collect(
      env.engine.search({
        query: q("tomato compost seedling"),
        lanes: ["lex", "vec"],
        collections: [COLLECTION],
      }),
    );
    expect(batches.map((b) => [b.stage, b.final])).toEqual([
      ["lex", false],
      ["vec", true],
    ]);
    expect(batches[1]!.results[0]!.path.startsWith("Garden/")).toBe(true);
    expect(batches[1]!.results[0]!.matchedBy).toEqual(["vec"]);
    expect(batches[1]!.results[0]!.scores.vec).toBeGreaterThan(0.3);
  });
  it("hybrid emits lex then fused", async () => {
    const batches = await collect(
      env.engine.search({
        query: q("sourdough starter"),
        lanes: ["hybrid"],
        collections: [COLLECTION],
      }),
    );
    expect(batches.map((b) => b.stage)).toEqual(["lex", "fused"]);
    expect(batches[1]!.results[0]!.scores.fused).toBeGreaterThan(0);
  });
  it("a lane prefix runs only that lane, and filters apply to it", async () => {
    const batches = await collect(
      env.engine.search({
        query: q("vec: marathon taper mileage path:Health"),
        lanes: ["lex", "vec"],
        collections: [COLLECTION],
      }),
    );
    expect(batches.map((b) => b.stage)).toEqual(["vec"]);
    expect(batches[0]!.results.every((r) => r.path.startsWith("Health/"))).toBe(true);
  });
  it("rejects a malformed query", async () => {
    await expect(
      collect(env.engine.search({ query: {} as never, lanes: ["lex"] })),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
  it("stops when the client aborts", async () => {
    const controller = new AbortController();
    const gen = env.engine.search(
      { query: q("tomato"), lanes: ["lex", "vec"], collections: [COLLECTION] },
      controller.signal,
    );
    await gen.next();
    controller.abort();
    await expect(gen.next()).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("ask", () => {
  it("Fast streams lex then fused", async () => {
    const batches = await collect(
      env.engine.ask({ query: q("? telescope nebula"), mode: "fast", collections: [COLLECTION] }),
    );
    expect(batches.map((b) => [b.stage, b.final])).toEqual([
      ["lex", false],
      ["fused", true],
    ]);
    expect(batches[1]!.mode).toBe("fast");
    expect(batches[1]!.results.length).toBeLessThanOrEqual(20);
    expect(batches[1]!.results.slice(0, 4).map((r) => r.label)).toEqual([
      "strong",
      "strong",
      "strong",
      "related",
    ]);
  });
  it("Deep streams three stages, with expansions and rerank scores", async () => {
    const batches = await collect(
      env.engine.ask({
        query: q("? what did I decide about chunk size"),
        mode: "auto",
        collections: [COLLECTION],
      }),
    );
    expect(batches.map((b) => b.stage)).toEqual(["lex", "fused", "rerank"]);
    const last = batches[2]!;
    expect(last.final).toBe(true);
    expect(last.mode).toBe("deep");
    expect(last.expansions!.length).toBeGreaterThan(0);
    expect(last.results[0]!.path).toBe("Trova.md");
    expect(last.results[0]!.block!.headings).toEqual(["Trova", "Chunk size"]);
    expect(last.results[0]!.scores.rerank).toBeGreaterThan(0);
    expect(last.results[0]!.matchedBy).toContain("rerank");
  });
  it("Auto picks Fast for a short keyword query", async () => {
    const batches = await collect(
      env.engine.ask({ query: q("? kanata"), mode: "auto", collections: [COLLECTION] }),
    );
    expect(batches[batches.length - 1]!.mode).toBe("fast");
  });
  it("keeps the fused results and notes 'rerank skipped' when Deep passes its deadline", async () => {
    const slow = await makeEnv({ deep: fakeDeep(300), index: true });
    try {
      const batches = await collect(
        slow.engine.ask({
          query: q("? how do I remap modifier keys on a layer"),
          mode: "deep",
          deadlineMs: 60,
          collections: [COLLECTION],
        }),
      );
      const last = batches[batches.length - 1]!;
      expect(last.stage).toBe("fused");
      expect(last.note).toBe("rerank_skipped");
      expect(last.results.length).toBeGreaterThan(0);
    } finally {
      await slow.cleanup();
    }
  }, 120000);
  it("falls back to Fast with a note when the Deep models are missing", async () => {
    const bare = await makeEnv({ deep: null });
    try {
      const batches = await collect(
        bare.engine.ask({
          query: q("? how do I remap modifier keys on a layer"),
          mode: "deep",
          collections: [COLLECTION],
        }),
      );
      const last = batches[batches.length - 1]!;
      expect(last).toMatchObject({
        stage: "fused",
        final: true,
        mode: "fast",
        note: "model_missing",
      });
    } finally {
      await bare.cleanup();
    }
  }, 120000);
});

describe("similarity graph", () => {
  it("returns the anchor, its related sources and edges between them", async () => {
    const g = await env.engine.graph({
      anchor: { source: src("Garden/Garden notes 1.md") },
      limit: 12,
      collections: [COLLECTION],
      loose: true,
    });
    expect(g.anchorIndexed).toBe(true);
    expect(g.anchor?.path).toBe("Garden/Garden notes 1.md");
    expect(g.nodes.length).toBeGreaterThan(2);
    expect(g.nodes.length).toBeLessThanOrEqual(12);
    const ids = new Set([g.anchor!.id, ...g.nodes.map((n) => n.id)]);
    expect(
      g.edges.every(
        (e) => ids.has(e.a) && ids.has(e.b) && e.a !== e.b && e.similarity > 0 && e.similarity <= 1,
      ),
    ).toBe(true);
    // One edge from the anchor to every node, and at least one edge between two related sources.
    expect(g.edges.filter((e) => e.a === g.anchor!.id).length).toBe(g.nodes.length);
    expect(g.edges.some((e) => e.a !== g.anchor!.id)).toBe(true);
    const between = new Map<string, number>();
    for (const e of g.edges.filter((x) => x.a !== g.anchor!.id))
      for (const id of [e.a, e.b]) between.set(id, (between.get(id) ?? 0) + 1);
    expect(Math.max(...between.values())).toBeLessThanOrEqual(3);
  });

  it("reports a text anchor without an anchor node", async () => {
    const g = await env.engine.graph({
      anchor: { text: "tomato seedling compost mulch harvest soil" },
      loose: true,
    });
    expect(g.anchor).toBeNull();
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.every((e) => g.nodes.some((n) => n.id === e.a))).toBe(true);
  });
});

describe("related, score and documents", () => {
  it("returns sources with their best blocks, without the anchor", async () => {
    const res = await env.engine.related({
      anchor: { source: src("Garden/Garden notes 1.md") },
      limit: 10,
      collections: [COLLECTION],
      loose: true,
    });
    expect(res.anchorIndexed).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.map((r) => r.path)).not.toContain("Garden/Garden notes 1.md");
    expect(res.results[0]!.path.startsWith("Garden/")).toBe(true);
    expect(res.results[0]!.id).toBe(res.results[0]!.source);
    expect(res.results[0]!.blocks!.length).toBeGreaterThan(0);
    expect(res.results[0]!.blocks![0]!.block).toBeDefined();
    expect(res.results[0]!.why).toBeDefined();
    const scores = res.results.map((r) => r.scores.fused!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
  it("supports block and text anchors, exclusion and filters", async () => {
    const block = await env.engine.related({
      anchor: { block: src("Trova.md#trova/chunk-size") },
      loose: true,
    });
    expect(block.anchorIndexed).toBe(true);
    const text = await env.engine.related({
      anchor: { text: "tomato seedling compost mulch harvest soil" },
      loose: true,
      exclude: { sources: [src("Garden/Garden notes 1.md")] },
      filters: q("path:Garden").filters,
    });
    expect(text.results.length).toBeGreaterThan(0);
    expect(
      text.results.every(
        (r) => r.path.startsWith("Garden/") && r.path !== "Garden/Garden notes 1.md",
      ),
    ).toBe(true);
    const strict = await env.engine.related({
      anchor: { text: "tomato seedling compost mulch harvest soil" },
    });
    expect(strict.results.every((r) => r.label !== "loose")).toBe(true);
  });
  it("rejects bad anchors and unknown ids", async () => {
    await expect(env.engine.related({ anchor: { source: "a", text: "b" } })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(env.engine.related({ anchor: { source: src("Nope.md") } })).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("scores pairs of anchors between 0 and 1", async () => {
    const { scores } = await env.engine.score({
      pairs: [
        [{ source: src("Dup A.md") }, { source: src("Dup B.md") }],
        [{ source: src("Dup A.md") }, { source: src("Garden/Garden notes 1.md") }],
      ],
    });
    expect(scores[0]!).toBeGreaterThan(0.9);
    expect(scores[1]!).toBeLessThan(scores[0]!);
  });
  it("gets sources, blocks with neighbours, and bare paths", () => {
    expect(env.engine.get({ id: src("Trova.md") }).content).toContain("reciprocal rank fusion");
    const block = env.engine.get({ id: src("Tools/Kanata.md#setup/install"), neighbours: 1 });
    expect(block.content.startsWith("## Install")).toBe(true);
    expect(block.content).toContain("Homebrew");
    expect(block.neighbours!.before[0]!.block!.headings).toEqual(["Setup"]);
    expect(block.neighbours!.after[0]!.id).toBe(src("Tools/Kanata.md#setup/install~2"));
    expect(env.engine.get({ id: "Tools/Kanata" }).id).toBe(src("Tools/Kanata.md"));
    expect(() => env.engine.get({ id: src("Trova.md#nope") })).toThrowError(/Unknown block/);
  });
  it("multi-get by ids and by glob", () => {
    const byIds = env.engine.multiGet({
      ids: [src("Trova.md"), src("Missing.md"), src("Secret.md")],
    });
    expect(byIds.documents.map((d) => d.path)).toEqual(["Trova.md"]);
    expect(byIds.errors).toEqual([
      { id: src("Missing.md"), code: "not_found" },
      { id: src("Secret.md"), code: "not_found" },
    ]);
    const byGlob = env.engine.multiGet({ glob: "Daily/*.md" });
    expect(byGlob.documents.map((d) => d.path)).toEqual([
      "Daily/2026-11-10.md",
      "Daily/2026-11-11.md",
    ]);
  });
  it("suggests vocabulary corrections and lists frontmatter keys", () => {
    const s = env.engine.vocabSuggest({ terms: ["lighthuose"] });
    expect(s.suggestions["lighthuose"]![0]).toMatchObject({ term: "lighthous", distance: 1 });
    const keys = env.engine.metadataKeys().keys;
    expect(keys["status"]).toEqual(["active", "done"]);
    expect(keys["authors"]).toEqual(["Ann", "Bob"]);
    expect(keys["trova"]).toBeUndefined();
  });
});

describe("vault care analysis", () => {
  it("finds near-duplicate sources", async () => {
    expect(env.engine.getDuplicates(true).state).toBe("running");
    await env.engine.drain();
    const d = env.engine.getDuplicates(false);
    expect(d.state).toBe("done");
    expect(d.pairs.some((p) => [p.aPath, p.bPath].sort().join("|") === "Dup A.md|Dup B.md")).toBe(
      true,
    );
  });
  it("clusters the vault into labelled topics", async () => {
    env.engine.getTopics(true);
    await env.engine.drain();
    const t = env.engine.getTopics(false);
    expect(t.state).toBe("done");
    expect(t.clusters.length).toBeGreaterThan(2);
    expect(t.clusters[0]!.label.length).toBeGreaterThan(0);
    expect(
      t.clusters.every((c) => c.sources.every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1)),
    ).toBe(true);
  });
});

describe("sync: changes, renames, jobs and events", () => {
  it("re-indexes edits, emits progress, stale and ready events, and keeps block ids stable", async () => {
    const events: EngineEvent[] = [];
    const off = env.engine.on((e) => events.push(e));
    const before = env.engine.get({ id: src("Tools/Kanata.md#usage") }).id;
    writeFileSync(join(env.vault, "Fresh.md"), "# Fresh\nA brand new note about quokkas.\n");
    const { jobId } = env.engine.sync({ collection: COLLECTION, changed: ["Fresh.md"] });
    expect(jobId).toMatch(/^j_\d+$/);
    expect(env.engine.sync({ collection: COLLECTION, changed: ["Fresh.md"] }).jobId).toBeDefined();
    await env.engine.drain();
    off();
    expect(paths(await lex("quokkas"))).toEqual(["Fresh.md"]);
    expect(events.some((e) => e.event === "index.progress")).toBe(true);
    expect(events.find((e) => e.event === "results.stale")!.data["sources"]).toContain(
      src("Fresh.md"),
    );
    expect(events.some((e) => e.event === "index.ready")).toBe(true);
    expect(env.engine.get({ id: src("Tools/Kanata.md#usage") }).id).toBe(before);
    const related = await env.engine.related({ anchor: { source: src("Fresh.md") }, loose: true });
    expect(related.anchorIndexed).toBe(true);
  });
  it("handles a rename: the old id resolves and vectors are kept", async () => {
    renameSync(join(env.vault, "Fresh.md"), join(env.vault, "Renamed.md"));
    env.engine.sync({ collection: COLLECTION, renamed: [{ from: "Fresh.md", to: "Renamed.md" }] });
    await env.engine.drain();
    expect(paths(await lex("quokkas"))).toEqual(["Renamed.md"]);
    expect(env.engine.get({ id: src("Fresh.md") }).path).toBe("Renamed.md");
    expect(env.engine.status().collections[0]!.pending).toBe(0);
  });
  it("removes deleted files", async () => {
    rmSync(join(env.vault, "Renamed.md"));
    env.engine.sync({ collection: COLLECTION, deleted: ["Renamed.md"] });
    await env.engine.drain();
    expect(paths(await lex("quokkas"))).toEqual([]);
  });
  it("stores pushed OCR text for images", async () => {
    writeFileSync(join(env.vault, "shot.png"), "not really a png");
    env.engine.attachmentText({
      collection: COLLECTION,
      path: "shot.png",
      text: "Screenshot of a narwhal dashboard",
    });
    await env.engine.drain();
    const hit = (await lex("narwhal")).results[0]!;
    expect(hit.path).toBe("shot.png");
    expect(hit.type).toBe("image");
  });
  it("rejects sync for an unknown collection and cancel for an unknown job", () => {
    expect(() => env.engine.sync({ collection: "nope" })).toThrowError(/Unknown collection/);
    expect(() => env.engine.cancelJob("j_999")).toThrowError(/Unknown job/);
  });
  it("sets path context and returns it on results", async () => {
    await env.engine.addCollection({
      name: COLLECTION,
      path: env.vault,
      context: { Tools: "Notes about tools I use" },
    });
    expect((await lex("kanata")).results[0]!.context).toBe("Notes about tools I use");
    expect((await env.engine.listCollections())[0]!.context).toEqual({
      Tools: "Notes about tools I use",
    });
  });
});

describe("HTTP server", () => {
  let server: RunningServer;
  const token = "test-token";
  const call = (path: string, init: RequestInit = {}, auth = true) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    server = await startServer(env.engine, { token, heartbeatMs: 50 });
  });
  afterAll(() => server.close());

  it("answers health without a token and rejects everything else without one", async () => {
    const health = await call("/health", {}, false);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      name: "trova",
      version: expect.any(String),
      api: API_VERSION,
      apis: [API_VERSION],
    });
    const res = await call("/v1/index/status", {}, false);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String), retryable: false },
    });
    expect(
      (await call("/v1/index/status", { headers: { Authorization: "Bearer wrong" } }, false))
        .status,
    ).toBe(401);
  });
  it("allows only the Obsidian origin and answers preflights", async () => {
    const pre = await call(
      "/v1/search",
      { method: "OPTIONS", headers: { Origin: "app://obsidian.md" } },
      false,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("app://obsidian.md");
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(
      (await call("/v1/index/status", { headers: { Origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect(
      (await call("/v1/index/status", { headers: { Origin: "app://obsidian.md" } })).status,
    ).toBe(200);
  });
  it("streams search as NDJSON, one batch per line, the last with final: true", async () => {
    const res = await post("/v1/search", {
      query: q("tomato compost"),
      lanes: ["lex", "vec"],
      collections: [COLLECTION],
      limit: 5,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ResultBatch);
    expect(lines.map((l) => l.stage)).toEqual(["lex", "vec"]);
    expect(lines.map((l) => l.final)).toEqual([false, true]);
  });
  it("streams ask in stage order", async () => {
    const res = await post("/v1/ask", {
      query: q("? what did I decide about chunk size"),
      mode: "deep",
      collections: [COLLECTION],
    });
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ResultBatch);
    expect(lines.map((l) => l.stage)).toEqual(["lex", "fused", "rerank"]);
  });
  it("serves every JSON endpoint", async () => {
    expect(
      (
        (await (
          await post("/v1/related", { anchor: { source: src("Trova.md") }, loose: true })
        ).json()) as { anchorIndexed: boolean }
      ).anchorIndexed,
    ).toBe(true);
    expect(await (await post("/v1/vocab/suggest", { terms: ["kanata"] })).json()).toEqual({
      suggestions: { kanata: [] },
    });
    expect(
      (
        (await (
          await post("/v1/score", {
            pairs: [[{ source: src("Trova.md") }, { source: src("Trova.md") }]],
          })
        ).json()) as { scores: number[] }
      ).scores[0],
    ).toBeCloseTo(1, 3);
    expect(
      (
        (await (await post("/v1/documents/get", { id: src("Trova.md") })).json()) as {
          path: string;
        }
      ).path,
    ).toBe("Trova.md");
    expect(
      (
        (await (await post("/v1/documents/multi-get", { glob: "Daily/*" })).json()) as {
          documents: unknown[];
        }
      ).documents,
    ).toHaveLength(2);
    expect(
      ((await (await call("/v1/collections")).json()) as { collections: { name: string }[] })
        .collections[0]!.name,
    ).toBe(COLLECTION);
    expect(
      ((await (await call("/v1/metadata/keys")).json()) as { keys: Record<string, string[]> }).keys[
        "status"
      ],
    ).toBeDefined();
    expect(((await (await call("/v1/index/status")).json()) as { api: string }).api).toBe(
      API_VERSION,
    );
    const sync = await post("/v1/index/sync", { collection: COLLECTION, full: true });
    expect(sync.status).toBe(202);
    const { jobId } = (await sync.json()) as { jobId: string };
    expect((await call(`/v1/jobs/${jobId}/cancel`, { method: "POST" })).status).toBe(204);
    await env.engine.drain();
  });
  it("returns the documented error codes and statuses", async () => {
    const cases: [Promise<Response>, number, string][] = [
      [post("/v1/search", { nope: true }), 400, "bad_request"],
      [call("/v1/search", { method: "POST", body: "{not json" }), 400, "bad_request"],
      [post("/v1/related", { anchor: { source: src("Missing.md") } }), 404, "not_found"],
      [post("/v1/documents/get", { id: src("Secret.md") }), 404, "not_found"],
      [post("/v1/index/sync", { collection: "nope" }), 404, "not_found"],
      [call("/v1/jobs/j_999/cancel", { method: "POST" }), 404, "not_found"],
      [call("/v1/unknown"), 404, "not_found"],
    ];
    for (const [pending, status, code] of cases) {
      const res = await pending;
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });
  it("cancels a stream when the client disconnects", async () => {
    const controller = new AbortController();
    const res = await call("/v1/ask", {
      method: "POST",
      body: JSON.stringify({
        query: q("? how do I remap modifier keys on a layer"),
        mode: "deep",
        collections: [COLLECTION],
      }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(((await (await call("/v1/index/status")).json()) as { api: string }).api).toBe(
      API_VERSION,
    );
  });
  it("sends events and heartbeats over SSE", async () => {
    const controller = new AbortController();
    const res = await call("/v1/events", { signal: controller.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(server.clients()).toBe(1);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    writeFileSync(join(env.vault, "Sse.md"), "# Sse\nAn event stream note.\n");
    await post("/v1/index/sync", { collection: COLLECTION, changed: ["Sse.md"] });
    const deadline = Date.now() + 10000;
    while (
      Date.now() < deadline &&
      !(text.includes("event: index.ready") && text.includes(": heartbeat"))
    ) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain("event: results.stale");
    expect(text).toContain("event: index.ready");
    expect(text).toContain(": heartbeat");
    await env.engine.drain();
  });
});
