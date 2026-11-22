// The `trova` CLI. Command names follow qmd wherever they overlap. Every command supports --json.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  EngineError,
  parseQuery,
  type CollectionInfo,
  type DocumentBody,
  type IndexStatus,
  type MultiGetResponse,
  type RelatedResponse,
  type Result,
  type ResultBatch,
} from "./contract/index.js";
import {
  TOPICS,
  loadQueries,
  runEval,
  runPerf,
  writeFixtureVault,
  writeGeneratedVault,
} from "./eval/index.js";
import { connect, connectOrStartDaemon, localTrova, type Trova } from "./client.js";
import { DaemonRunningError, startDaemon } from "./daemon.js";
import { Engine } from "./engine.js";
import { runMcpHttp, runMcpStdio } from "./mcp.js";
import { ENGINE_VERSION, isProcessAlive, trovaHome, readDaemonInfo } from "./paths.js";
import { fakeDeep, hashEmbedder } from "./testing.js";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["json", "perf", "http", "debug", "help", "version", "real", "full"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
      if (inline !== undefined) flags[key] = inline;
      else if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith("--"))
        flags[key] = true;
      else flags[key] = argv[++i]!;
    } else if (a === "-n") flags["limit"] = argv[++i] ?? "10";
    else if (a === "-c") flags["collection"] = argv[++i] ?? "";
    else positional.push(a);
  }
  return { positional, flags };
}

const HELP = `trova ${ENGINE_VERSION} - local keyword and semantic search for Markdown notes

Usage: trova <command> [options]

  collection add <path> [--name <name>]    Add a folder as a collection
  collection ls | rm <name> | rename <old> <new>
  context add <collection> <path> <text>   Describe a folder to improve ranking
  context ls | rm <collection> <path>
  update [-c <collection>]                 Rescan collections for changes
  embed                                    Embed new and changed blocks
  watch [--port <n>] [--debug]             Run the daemon: watcher, indexer and HTTP API
  serve [--port <n>] [--debug]             HTTP API only, no watcher
  search <query>                           Keyword lane, typo tolerant
  vsearch <query>                          Vector lane
  query <query> [--mode fast|deep]         Hybrid search (alias: ask)
  related <path>[#heading-path]            Related sources and blocks
  get <id|path>                            Print one source or block
  multi-get <glob | id,id,...>             Print several sources
  status | doctor                          Health, counts and model identity
  mcp [--http] [--port <n>]                MCP server over stdio, or HTTP on 127.0.0.1 (port 8181)
  eval [--queries <file>] [--real]         nDCG@10 and Recall@20 on the fixture vault or your queries
  eval --perf [--notes <n>]                Latency budgets on a generated vault (10,000 notes)

Common options: --json, -n/--limit <n>, -c/--collection <name>`;

/** The --limit flag as a whole number of at least 1, or `fallback` when it is not given. */
function limitOf(flags: Args["flags"], fallback = 10): number {
  const raw = flags["limit"];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--limit needs a whole number of at least 1, not "${raw}"`);
  return n;
}

function out(flags: Args["flags"], value: unknown, text: () => string): void {
  console.log(flags["json"] ? JSON.stringify(value, null, 2) : text());
}

function formatResults(results: Result[]): string {
  if (results.length === 0) return "No matches.";
  return results
    .map((r) => {
      const score = r.scores.rerank ?? r.scores.fused ?? r.scores.vec ?? r.scores.lex ?? 0;
      const heading = r.block?.headings.length ? `#${r.block.headings.join(" > ")}` : "";
      return `${score.toFixed(3).padStart(7)}  ${r.path}${heading}  [${r.matchedBy.join(",")} ${r.label}]\n         ${r.snippet}`;
    })
    .join("\n");
}

function progressLine(kind: string, done: number, total: number): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\r${kind} ${done.toLocaleString()} / ${total.toLocaleString()}   `);
}

/** better-sqlite3's prebuilt binary crashes the process on some Node versions; probe it in a child first. */
function sqliteWorks(): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(':memory:');d.prepare('select 1').get();require('sqlite-vec').load(d)",
    ],
    { cwd: import.meta.dirname, stdio: "ignore" },
  );
  return probe.status === 0;
}

function requireSqlite(): void {
  const marker = join(trovaHome(), `.sqlite-ok-${process.version}`);
  if (existsSync(marker)) return;
  if (!sqliteWorks()) {
    throw new Error(
      `SQLite cannot load on Node ${process.version}. Run trova with a newer Node (24 is verified) or rebuild: npm rebuild better-sqlite3 --build-from-source`,
    );
  }
  try {
    writeFileSync(marker, "");
  } catch {
    /* the marker only saves the probe next time */
  }
}

async function collectionsOf(trova: Trova): Promise<CollectionInfo[]> {
  return (await trova.json<{ collections: CollectionInfo[] }>("GET", "/v1/collections"))
    .collections;
}

async function syncAll(trova: Trova, only?: string): Promise<void> {
  const cols = (await collectionsOf(trova)).filter((c) => !only || c.name === only);
  if (cols.length === 0)
    throw new Error(
      only
        ? `Unknown collection "${only}"`
        : "No collections. Add one with: trova collection add <path>",
    );
  for (const c of cols)
    await trova.json("POST", "/v1/index/sync", { collection: c.name, full: true });
  await trova.wait(progressLine);
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
}

async function lastBatch(stream: AsyncIterable<ResultBatch>): Promise<ResultBatch> {
  let last: ResultBatch = { stage: "lex", results: [], final: true };
  for await (const b of stream)
    if (b.results.length > 0 || b.final)
      last = b.results.length || !last.results.length ? b : { ...last, note: b.note };
  return last;
}

async function runSearch(
  trova: Trova,
  args: Args,
  kind: "search" | "vsearch" | "query",
): Promise<void> {
  const raw = args.positional.join(" ");
  if (!raw.trim()) throw new Error(`Usage: trova ${kind} <query>`);
  const limit = limitOf(args.flags);
  const collections =
    typeof args.flags["collection"] === "string" ? [args.flags["collection"]] : undefined;
  const query = parseQuery(raw, { mode: kind === "query" ? "ask" : "instant" }).query;
  const batch =
    kind === "query"
      ? await lastBatch(
          trova.stream("/v1/ask", {
            query,
            mode: args.flags["mode"] ?? "auto",
            collections,
            limit,
          }),
        )
      : await lastBatch(
          trova.stream("/v1/search", {
            query,
            lanes: [kind === "search" ? "lex" : "vec"],
            collections,
            limit,
          }),
        );
  out(args.flags, batch, () => {
    const head = batch.correction
      ? `Showing results for "${batch.correction.to}" instead of "${batch.correction.from}"\n`
      : "";
    const note =
      batch.note === "rerank_skipped"
        ? "\n(rerank skipped: deadline passed)"
        : batch.note === "model_missing"
          ? "\n(Deep models are not downloaded; ran in Fast mode)"
          : "";
    return head + formatResults(batch.results) + note;
  });
}

async function runEvalCommand(args: Args): Promise<void> {
  const queriesFile = typeof args.flags["queries"] === "string" ? args.flags["queries"] : null;
  if (queriesFile && !args.flags["perf"]) {
    // Against the real index, with the user's own queries.
    const trova = await connect();
    try {
      const report = await runEval(
        trova,
        loadQueries(queriesFile),
        typeof args.flags["collection"] === "string" ? args.flags["collection"] : undefined,
      );
      out(args.flags, report, () =>
        report.rows
          .map(
            (r) =>
              `${r.group.padEnd(20)} ${r.metric.padEnd(10)} ${r.value.toFixed(3)}  (${r.queries} queries)`,
          )
          .join("\n"),
      );
    } finally {
      await trova.close();
    }
    return;
  }
  // Without a query file the run is self-contained: a temporary data directory, a generated vault
  // and stand-in models, so it measures the engine and not the model.
  const root = mkdtempSync(join(tmpdir(), "trova-eval-"));
  // --real uses the real models, which must already be downloaded; nothing else changes.
  const real = args.flags["real"] === true;
  const engine = await Engine.open(
    real
      ? { home: join(root, "home") }
      : { home: join(root, "home"), embedder: hashEmbedder(), deep: fakeDeep() },
  );
  const trova = localTrova(engine);
  try {
    const vault = join(root, "vault");
    if (args.flags["perf"]) {
      const count = Number(args.flags["notes"] ?? 10000);
      console.error(
        `Generating and indexing ${count.toLocaleString()} notes with a stand-in embedder...`,
      );
      writeGeneratedVault(vault, count);
      await trova.json("POST", "/v1/collections", { name: "perf", path: vault });
      await syncAll(trova, "perf");
      const anchors = Array.from(
        { length: 20 },
        (_, i) =>
          `${TOPICS[i % TOPICS.length]!.folder}/0/${TOPICS[i % TOPICS.length]!.title} ${i}.md`,
      );
      const rows = await runPerf(
        trova,
        "perf",
        anchors,
        TOPICS.flatMap((t) => t.terms),
      );
      out(
        args.flags,
        rows,
        () =>
          rows
            .map((r) => {
              const ok = r.p95 <= r.targetP95 ? "ok  " : "OVER";
              return `${ok} ${r.interaction.padEnd(52)} p50 ${r.p50.toFixed(1).padStart(7)} ms (target ${r.targetP50})  p95 ${r.p95.toFixed(1).padStart(7)} ms (target ${r.targetP95})`;
            })
            .join("\n") +
          "\nNot measured here: paint-time budgets, which need Obsidian. Vector timings use a stand-in embedder, so they exclude model time.",
      );
    } else {
      const fixture = writeFixtureVault(vault);
      await trova.json("POST", "/v1/collections", { name: "fixture", path: vault });
      await syncAll(trova, "fixture");
      const report = await runEval(trova, fixture.queries, "fixture");
      out(
        args.flags,
        report,
        () =>
          report.rows
            .map(
              (r) =>
                `${r.group.padEnd(20)} ${r.metric.padEnd(10)} ${r.value.toFixed(3)}  (${r.queries} queries)`,
            )
            .join("\n") +
          (real
            ? "\nFixture vault with the real models."
            : "\nFixture vault with a stand-in embedder. Pass --real for the real models, or --queries <file> to evaluate the real index."),
      );
    }
  } finally {
    await trova.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function runDaemon(args: Args, watch: boolean): Promise<void> {
  try {
    const daemon = await startDaemon({
      watch,
      port: args.flags["port"] ? Number(args.flags["port"]) : undefined,
      debug: args.flags["debug"] === true,
      onExit: () => process.exit(0),
    });
    // The process that started the daemon may close the pipe; a later write must not stop the daemon.
    process.stderr.on("error", () => undefined);
    console.error(
      `trova ${watch ? "watch" : "serve"}: listening on 127.0.0.1:${daemon.server.port} (pid ${process.pid})`,
    );
    const shutdown = () => void daemon.stop().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => undefined);
  } catch (err) {
    if (err instanceof DaemonRunningError) {
      console.error(err.message);
      process.exit(0);
    }
    throw err;
  }
}

async function doctor(args: Args): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node version", ok: major >= 22, detail: process.version });
  const sqlite = sqliteWorks();
  checks.push({
    name: "SQLite and sqlite-vec load",
    ok: sqlite,
    detail: sqlite
      ? "ok"
      : `crashes on Node ${process.version}; use Node 24 or rebuild better-sqlite3 from source`,
  });
  const info = readDaemonInfo();
  checks.push({
    name: "Daemon",
    ok: true,
    detail:
      info && isProcessAlive(info.pid)
        ? `running, pid ${info.pid}, port ${info.port}`
        : "not running (commands run in-process)",
  });
  checks.push({ name: "Data directory", ok: true, detail: trovaHome() });
  let trova: Trova | null = null;
  if (sqlite) {
    try {
      trova = await connect();
    } catch (err) {
      // The engine refuses to open an index whose layout it cannot read.
      checks.push({ name: "Index", ok: false, detail: (err as Error).message });
    }
  }
  if (trova) {
    try {
      const status = await trova.json<IndexStatus>("GET", "/v1/index/status");
      checks.push({ name: "Backend", ok: true, detail: status.engine.backend });
      checks.push({
        name: "Embedding model",
        ok: status.models.embed.state !== "missing",
        detail: `${status.models.embed.id ?? "?"}: ${status.models.embed.state}`,
      });
      checks.push({
        name: "Deep models",
        ok: true,
        detail: `rerank ${status.models.rerank.state}, expansion ${status.models.expand.state}`,
      });
      for (const c of status.collections)
        checks.push({
          name: `Collection ${c.name}`,
          ok: existsSync(c.path),
          detail: `${c.sources} sources, ${c.embedded} embedded, ${c.path}`,
        });
    } finally {
      await trova.close();
    }
  }
  out(args.flags, checks, () =>
    checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`).join("\n"),
  );
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!command || command === "help" || command === "--help" || args.flags["help"]) {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "version") {
    console.log(ENGINE_VERSION);
    return;
  }
  if (command === "doctor") return doctor(args);
  requireSqlite();
  if (command === "watch") return runDaemon(args, true);
  if (command === "serve") return runDaemon(args, false);
  if (command === "eval") return runEvalCommand(args);
  if (command === "mcp") {
    const trova = await connectOrStartDaemon();
    if (args.flags["http"]) {
      const port = await runMcpHttp(trova, Number(args.flags["port"] ?? 8181));
      console.error(`trova mcp: http://127.0.0.1:${port}/mcp`);
    } else await runMcpStdio(trova);
    return;
  }

  const trova = await connect();
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    void trova.close().then(() => process.exit(130));
  });
  try {
    const [sub, ...subArgs] = args.positional;
    switch (command) {
      case "collection": {
        if (sub === "add") {
          const path = resolve(subArgs[0] ?? ".");
          const name =
            typeof args.flags["name"] === "string"
              ? args.flags["name"]
              : basename(path)
                  .toLowerCase()
                  .replace(/[^a-z0-9_-]+/g, "-")
                  .replace(/^-+|-+$/g, "") || "collection";
          const info = await trova.json<CollectionInfo>("POST", "/v1/collections", {
            name,
            path,
            options: { kind: "folder" },
          });
          await syncAll(trova, name);
          out(args.flags, info, () => `Added collection "${name}" at ${path}`);
        } else if (sub === "rm") {
          if (!subArgs[0]) throw new Error("Usage: trova collection rm <name>");
          await trova.json("DELETE", `/v1/collections?name=${encodeURIComponent(subArgs[0])}`);
          out(args.flags, { removed: subArgs[0] }, () => `Removed collection "${subArgs[0]}"`);
        } else if (sub === "rename") {
          if (!subArgs[0] || !subArgs[1])
            throw new Error("Usage: trova collection rename <old> <new>");
          await trova.json("POST", "/v1/collections", { name: subArgs[0], rename: subArgs[1] });
          await trova.wait(progressLine);
          out(args.flags, { renamed: subArgs }, () => `Renamed "${subArgs[0]}" to "${subArgs[1]}"`);
        } else {
          const cols = await collectionsOf(trova);
          out(args.flags, cols, () =>
            cols.length ? cols.map((c) => `${c.name}  ${c.path}`).join("\n") : "No collections.",
          );
        }
        break;
      }
      case "context": {
        if (sub === "add") {
          const [collection, path, ...text] = subArgs;
          if (!collection || path === undefined || text.length === 0)
            throw new Error("Usage: trova context add <collection> <path> <text>");
          await trova.json("POST", "/v1/collections", {
            name: collection,
            contextPath: path,
            contextText: text.join(" "),
          });
          out(args.flags, { collection, path }, () => `Context set for ${collection}:${path}`);
        } else if (sub === "rm") {
          const [collection, path] = subArgs;
          if (!collection || path === undefined)
            throw new Error("Usage: trova context rm <collection> <path>");
          await trova.json("POST", "/v1/collections", { name: collection, contextPath: path });
          out(args.flags, { collection, path }, () => `Context removed for ${collection}:${path}`);
        } else {
          const cols = await collectionsOf(trova);
          const rows = cols.flatMap((c) =>
            Object.entries(c.context).map(([path, text]) => ({ collection: c.name, path, text })),
          );
          out(args.flags, rows, () =>
            rows.length
              ? rows.map((r) => `${r.collection}:${r.path}  ${r.text}`).join("\n")
              : "No contexts.",
          );
        }
        break;
      }
      case "update":
      case "embed": {
        await syncAll(
          trova,
          typeof args.flags["collection"] === "string" ? args.flags["collection"] : undefined,
        );
        const status = await trova.json<IndexStatus>("GET", "/v1/index/status");
        out(args.flags, status.collections, () =>
          status.collections
            .map((c) => `${c.name}: ${c.sources} sources, ${c.embedded} embedded`)
            .join("\n"),
        );
        break;
      }
      case "search":
        await runSearch(trova, args, "search");
        break;
      case "vsearch":
        await runSearch(trova, args, "vsearch");
        break;
      case "query":
      case "ask":
        await runSearch(trova, args, "query");
        break;
      case "related": {
        if (!sub) throw new Error("Usage: trova related <path>[#heading-path]");
        const collection =
          typeof args.flags["collection"] === "string" ? args.flags["collection"] : undefined;
        const doc = await trova.json<DocumentBody>("POST", "/v1/documents/get", {
          id: sub,
          collection,
        });
        const res = await trova.json<RelatedResponse>("POST", "/v1/related", {
          anchor: doc.block ? { block: doc.id } : { source: doc.id },
          limit: limitOf(args.flags),
          granularity: "both",
        });
        out(args.flags, res, () =>
          !res.anchorIndexed
            ? "Not indexed yet. Run: trova embed"
            : res.results.length === 0
              ? "No related sources."
              : res.results
                  .map(
                    (r) =>
                      `${(r.scores.fused ?? r.scores.vec ?? 0).toFixed(3).padStart(7)}  ${r.path}  [${r.label}]${(r.blocks ?? []).map((b) => `\n         ${b.block?.headings.join(" > ") || "(top)"}: ${b.snippet.slice(0, 90)}`).join("")}`,
                  )
                  .join("\n"),
        );
        break;
      }
      case "get": {
        if (!sub) throw new Error("Usage: trova get <id|path>");
        const doc = await trova.json<DocumentBody>("POST", "/v1/documents/get", {
          id: sub,
          collection: args.flags["collection"],
        });
        out(args.flags, doc, () => doc.content);
        break;
      }
      case "multi-get": {
        if (!sub) throw new Error("Usage: trova multi-get <glob | id,id,...>");
        const isGlob = /[*?{]/.test(sub);
        const res = await trova.json<MultiGetResponse>(
          "POST",
          "/v1/documents/multi-get",
          isGlob
            ? { glob: sub, collection: args.flags["collection"] }
            : { ids: sub.split(","), collection: args.flags["collection"] },
        );
        out(
          args.flags,
          res,
          () =>
            res.documents.map((d) => `=== ${d.path} ===\n${d.content}`).join("\n\n") +
            res.errors.map((e) => `\n${e.id}: ${e.code}`).join(""),
        );
        break;
      }
      case "status": {
        const status = await trova.json<IndexStatus>("GET", "/v1/index/status");
        out(args.flags, status, () =>
          [
            `${status.engine.name} ${status.engine.version} (${status.engine.backend}), API ${status.api}${trova.local ? ", in-process" : ", daemon"}`,
            `Embedding model: ${status.models.embed.id ?? "?"} (${status.models.embed.state}${status.models.embed.dims ? `, ${status.models.embed.dims} dims` : ""})`,
            `Rerank: ${status.models.rerank.state}, expansion: ${status.models.expand.state}`,
            `Capabilities: ${status.capabilities.join(", ")}`,
            ...status.collections.map(
              (c) =>
                `${c.name}: ${c.sources} sources, ${c.embedded} embedded, ${c.pending} pending  ${c.path}`,
            ),
            ...status.jobs.map((j) => `job ${j.jobId} ${j.kind} ${j.state} ${j.done}/${j.total}`),
          ].join("\n"),
        );
        break;
      }
      default:
        throw new Error(`Unknown command "${command}". Run: trova help`);
    }
  } catch (err) {
    if (err instanceof EngineError && args.flags["json"]) console.log(JSON.stringify(err.toBody()));
    else console.error(`trova: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await trova.close();
  }
}
