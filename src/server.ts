// The /v1 HTTP contract on node:http. Binds 127.0.0.1 only and rejects any request without the
// bearer token. Streaming responses are newline-delimited JSON; events are Server-Sent Events.

import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  API_VERSION,
  ERROR_STATUS,
  EngineError,
  type ErrorBody,
  type HealthResponse,
  type ResultBatch,
} from "./contract/index.js";
import type { Engine } from "./engine.js";
import { ENGINE_NAME, ENGINE_VERSION } from "./paths.js";
import { dispatch } from "./routes.js";

export const ALLOWED_ORIGIN = "app://obsidian.md";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_INTERACTIVE = 32;
const HEARTBEAT_MS = 15_000;

export interface ServerOptions {
  token: string;
  port?: number;
  /** Write one line per request to logs/daemon.log. Queries are logged only when this is on. */
  debug?: boolean;
  heartbeatMs?: number;
}

export interface RunningServer {
  server: Server;
  port: number;
  /** Number of open event streams. */
  clients(): number;
  setDebug(on: boolean): void;
  close(): Promise<void>;
}

function toError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof SyntaxError)
    return new EngineError("bad_request", "The request body is not valid JSON");
  const message = err instanceof Error ? err.message : String(err);
  if (/model/i.test(message) && /(download|not found|missing)/i.test(message))
    return new EngineError("model_missing", message, true);
  return new EngineError("internal", message);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, err: EngineError): void {
  const headers: Record<string, string> = {};
  if (err.code === "model_loading" || err.code === "busy")
    headers["Retry-After"] = String(Math.ceil((err.retryAfterMs ?? 1000) / 1000));
  sendJson(res, ERROR_STATUS[err.code], err.toBody(), headers);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES)
      throw new EngineError("bad_request", "The request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EngineError("bad_request", "The request body must be a JSON object");
  return value as Record<string, unknown>;
}

export async function startServer(engine: Engine, opts: ServerOptions): Promise<RunningServer> {
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const sse = new Set<ServerResponse>();
  let interactive = 0;
  let debug = opts.debug === true;

  const log = (line: string) => {
    if (!debug) return;
    try {
      appendFileSync(
        join(engine.paths.logs, "daemon.log"),
        `${new Date().toISOString()} ${line}\n`,
      );
    } catch {
      /* logging must never break a request */
    }
  };

  const authorised = (req: IncomingMessage): boolean => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  /** Streams batches as NDJSON. The first batch is produced before the headers, so early errors get a real status. */
  const stream = async (
    res: ServerResponse,
    controller: AbortController,
    iterator: AsyncGenerator<ResultBatch>,
  ) => {
    if (interactive >= MAX_INTERACTIVE)
      throw new EngineError("busy", "The interactive queue is full", true, 200);
    interactive++;
    try {
      const first = await iterator.next();
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      try {
        let step = first;
        while (!step.done) {
          if (controller.signal.aborted) break;
          res.write(`${JSON.stringify(step.value)}\n`);
          step = await iterator.next();
        }
      } catch (err) {
        // Inside a stream an error is the last line.
        const e = toError(err);
        if (e.code !== "cancelled") res.write(`${JSON.stringify(e.toBody())}\n`);
      }
      res.end();
    } finally {
      interactive--;
      void iterator.return(undefined);
    }
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === "/health" && method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        name: ENGINE_NAME,
        version: ENGINE_VERSION,
        api: API_VERSION,
        apis: [API_VERSION],
      } satisfies HealthResponse);
    }
    if (!authorised(req)) throw new EngineError("unauthorized", "Missing or wrong token");
    engine.lastActivity = Date.now();
    const body = method === "POST" || method === "DELETE" ? await readBody(req) : {};
    if (path === "/v1/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sse.add(res);
      const off = engine.on((e) =>
        res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
      );
      const beat = setInterval(
        () => res.write(": heartbeat\n\n"),
        opts.heartbeatMs ?? HEARTBEAT_MS,
      );
      res.on("close", () => {
        clearInterval(beat);
        off();
        sse.delete(res);
        engine.lastActivity = Date.now();
      });
      return;
    }
    if (path === "/v1/debug" && method === "POST") {
      debug = (body as { on?: boolean }).on === true;
      return sendJson(res, 200, { debug });
    }
    if (path === "/v1/search" || path === "/v1/ask")
      log(`${path} ${JSON.stringify((body as { query?: { raw?: string } }).query?.raw ?? "")}`);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);
    const out = await dispatch(engine, method, path, body, url.searchParams, controller.signal);
    if (out.kind === "stream") return stream(res, controller, out.batches);
    res.off("close", onClose);
    if (out.kind === "empty") {
      res.writeHead(out.status);
      return void res.end();
    }
    return sendJson(res, out.status, out.body);
  };

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (origin !== ALLOWED_ORIGIN) {
        return sendJson(res, 403, {
          error: { code: "unauthorized", message: "Origin not allowed", retryable: false },
        } satisfies ErrorBody);
      }
      res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
        "Access-Control-Max-Age": "600",
      });
      return void res.end();
    }
    const started = Date.now();
    const requestId = req.headers["x-request-id"];
    if (typeof requestId === "string") res.setHeader("X-Request-Id", requestId);
    route(req, res)
      .catch((err) => {
        const e = toError(err);
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (e.code === "cancelled") {
          res.writeHead(ERROR_STATUS.cancelled);
          return void res.end();
        }
        sendError(res, e);
      })
      .finally(() => log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    port,
    clients: () => sse.size,
    setDebug: (on) => {
      debug = on;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of sse) res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
