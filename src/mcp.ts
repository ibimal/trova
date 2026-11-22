// The MCP server. Its tools proxy to the shared daemon, so an agent sees the same index and
// ranking as the plugin and never loads a second copy of the models.

import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  parseQuery,
  type DocumentBody,
  type Filter,
  type RelatedResponse,
  type Result,
  type ResultBatch,
} from "./contract/index.js";
import type { Trova } from "./client.js";
import { ENGINE_VERSION } from "./paths.js";

const str = { type: "string" } as const;
const collections = {
  type: "array",
  items: str,
  description: "Collection names to search. Default: all.",
} as const;
const limit = { type: "number", description: "Maximum number of results. Default 10." } as const;

/** A tool argument as text; anything that is not a string becomes "". */
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export const MCP_TOOLS = [
  {
    name: "search",
    description:
      "Search notes with typed sub-queries. Each sub-query has a type (lex = keywords, vec = meaning, hyde = a hypothetical answer passage) and a query in the Trova query language (filters such as tag:, path:, modified: are allowed).",
    inputSchema: {
      type: "object",
      properties: {
        searches: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string", enum: ["lex", "vec", "hyde"] }, query: str },
            required: ["type", "query"],
          },
        },
        query: {
          ...str,
          description: "Shortcut for one hybrid query, used when `searches` is absent.",
        },
        collections,
        limit,
      },
    },
  },
  {
    name: "ask",
    description: "Hybrid question search: keyword and vector results fused, reranked in deep mode.",
    inputSchema: {
      type: "object",
      properties: {
        question: str,
        mode: { type: "string", enum: ["auto", "fast", "deep"] },
        collections,
        limit,
      },
      required: ["question"],
    },
  },
  {
    name: "related",
    description:
      "Related notes and blocks for a note path (optionally with #heading-path) or for a text.",
    inputSchema: { type: "object", properties: { path: str, text: str, collections, limit } },
  },
  {
    name: "get",
    description: "Read one source or block by id or path.",
    inputSchema: { type: "object", properties: { id: str, collection: str }, required: ["id"] },
  },
  {
    name: "multi_get",
    description: "Read several sources by ids or by a glob over paths.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: str }, glob: str, collection: str },
    },
  },
  {
    name: "status",
    description: "Index health: counts, models, jobs and capabilities.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "metadata",
    description: "Frontmatter keys and their values, for building filters.",
    inputSchema: { type: "object", properties: { collections } },
  },
] as const;

function formatResults(results: Result[]): string {
  if (results.length === 0) return "No results.";
  return results
    .map((r, i) => {
      const heading = r.block?.headings.length ? ` > ${r.block.headings.join(" > ")}` : "";
      const score = r.scores.rerank ?? r.scores.fused ?? r.scores.vec ?? r.scores.lex ?? 0;
      return `${i + 1}. ${r.path}${heading}\n   id: ${r.id}\n   score: ${score.toFixed(3)} (${r.matchedBy.join(", ")}, ${r.label})\n   ${r.snippet}`;
    })
    .join("\n");
}

async function lastBatch(stream: AsyncIterable<ResultBatch>): Promise<ResultBatch | null> {
  let last: ResultBatch | null = null;
  for await (const b of stream) if (b.results.length > 0 || !last) last = b;
  return last;
}

export async function callTool(
  trova: Trova,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const cols = Array.isArray(args["collections"]) ? (args["collections"] as string[]) : undefined;
  const max = typeof args["limit"] === "number" ? args["limit"] : 10;
  switch (name) {
    case "search": {
      const searches = Array.isArray(args["searches"])
        ? (args["searches"] as { type: string; query: string }[])
        : [];
      if (searches.length === 0) {
        if (typeof args["query"] !== "string")
          throw new Error("search needs `searches` or `query`");
        const batch = await lastBatch(
          trova.stream("/v1/search", {
            query: parseQuery(args["query"]).query,
            lanes: ["hybrid"],
            collections: cols,
            limit: max,
          }),
        );
        return formatResults(batch?.results ?? []);
      }
      // Each typed sub-query runs in its lane; the lists are merged by best rank.
      const best = new Map<string, { rank: number; result: Result }>();
      for (const s of searches) {
        const query = parseQuery(`${s.type}: ${s.query}`).query;
        const batch = await lastBatch(
          trova.stream("/v1/search", {
            query,
            lanes: [s.type === "lex" ? "lex" : "vec"],
            collections: cols,
            limit: max,
          }),
        );
        (batch?.results ?? []).forEach((result, rank) => {
          const prev = best.get(result.id);
          if (!prev || rank < prev.rank) best.set(result.id, { rank, result });
        });
      }
      return formatResults(
        [...best.values()]
          .sort((a, b) => a.rank - b.rank)
          .slice(0, max)
          .map((b) => b.result),
      );
    }
    case "ask": {
      const query = parseQuery(text(args["question"]), { mode: "ask" }).query;
      const batch = await lastBatch(
        trova.stream("/v1/ask", {
          query,
          mode: args["mode"] ?? "auto",
          collections: cols,
          limit: max,
        }),
      );
      return formatResults(batch?.results ?? []);
    }
    case "related": {
      let anchor: Record<string, string>;
      if (typeof args["text"] === "string" && args["text"]) anchor = { text: args["text"] };
      else {
        const doc = await trova.json<DocumentBody>("POST", "/v1/documents/get", {
          id: text(args["path"]),
        });
        anchor = doc.block ? { block: doc.id } : { source: doc.id };
      }
      const res = await trova.json<RelatedResponse>("POST", "/v1/related", {
        anchor,
        limit: max,
        collections: cols,
        granularity: "both",
      });
      if (!res.anchorIndexed) return "The anchor is not embedded yet.";
      return formatResults(res.results);
    }
    case "get": {
      const doc = await trova.json<DocumentBody>("POST", "/v1/documents/get", {
        id: String(args["id"]),
        collection: args["collection"],
      });
      return `# ${doc.path}${doc.block?.headings.length ? ` > ${doc.block.headings.join(" > ")}` : ""}\n\n${doc.content}`;
    }
    case "multi_get": {
      const res = await trova.json<{
        documents: DocumentBody[];
        errors: { id: string; code: string }[];
      }>("POST", "/v1/documents/multi-get", args);
      const docs = res.documents.map((d) => `# ${d.path}\n\n${d.content}`).join("\n\n---\n\n");
      const errors = res.errors.map((e) => `${e.id}: ${e.code}`).join("\n");
      return [docs, errors && `Errors:\n${errors}`].filter(Boolean).join("\n\n") || "No documents.";
    }
    case "status":
      return JSON.stringify(await trova.json("GET", "/v1/index/status"), null, 2);
    case "metadata": {
      const qs = (cols ?? []).map((c) => `collection=${encodeURIComponent(c)}`).join("&");
      return JSON.stringify(
        await trova.json("GET", `/v1/metadata/keys${qs ? `?${qs}` : ""}`),
        null,
        2,
      );
    }
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}

export function createMcpServer(trova: Trova): Server {
  const server = new Server(
    { name: "trova", version: ENGINE_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS as unknown as never[],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await callTool(
        trova,
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      );
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });
  return server;
}

export async function runMcpStdio(trova: Trova): Promise<void> {
  await createMcpServer(trova).connect(new StdioServerTransport());
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Whether a request comes from this machine. The server binds 127.0.0.1 and has no token, so a web
 * page on a domain that resolves to 127.0.0.1 (DNS rebinding) could reach it; its Host and Origin
 * name that domain. The MCP specification asks servers to check them for this reason.
 */
export function isLoopbackRequest(host: string | undefined, origin: string | undefined): boolean {
  if (!host || !LOOPBACK_HOST.test(host)) return false;
  if (origin === undefined) return true;
  try {
    return LOOPBACK_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

/** MCP over streamable HTTP on 127.0.0.1, stateless: one server and transport per request. */
export async function runMcpHttp(trova: Trova, port: number): Promise<number> {
  const http = createServer(async (req, res) => {
    if (!isLoopbackRequest(req.headers.host, req.headers.origin)) {
      res.writeHead(403).end();
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer(trova);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", () => resolve()));
  const address = http.address();
  return typeof address === "object" && address ? address.port : port;
}

export type { Filter };
