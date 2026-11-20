// How the CLI and the MCP server reach the engine: over HTTP when a daemon runs, so no second
// copy of the models is loaded; otherwise in-process.

import { spawn } from "node:child_process";
import { EngineError, type ErrorBody, type ResultBatch } from "@trova/contract";
import { Engine } from "./engine.js";
import { trovaHome, readDaemonInfo } from "./paths.js";
import { dispatch } from "./routes.js";

export interface Trova {
  local: boolean;
  json<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
  stream(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<ResultBatch>;
  /** Resolves when the engine has no queued or running job. Reports progress while it waits. */
  wait(onProgress?: (kind: string, done: number, total: number) => void): Promise<void>;
  close(): Promise<void>;
}

function splitPath(path: string): { pathname: string; params: URLSearchParams } {
  const url = new URL(path, "http://127.0.0.1");
  return { pathname: url.pathname, params: url.searchParams };
}

export function localTrova(engine: Engine, ownsEngine = true): Trova {
  return {
    local: true,
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const { pathname, params } = splitPath(path);
      const out = await dispatch(engine, method, pathname, (body ?? {}) as Record<string, unknown>, params);
      if (out.kind === "json") return out.body as T;
      return undefined as T;
    },
    async *stream(path, body, signal) {
      const out = await dispatch(engine, "POST", path, body as Record<string, unknown>, new URLSearchParams(), signal);
      if (out.kind === "stream") yield* out.batches;
    },
    async wait(onProgress) {
      const off = engine.on((e) => {
        if (e.event === "index.progress") onProgress?.(String(e.data["stage"] ?? e.data["kind"]), Number(e.data["done"]), Number(e.data["total"]));
      });
      await engine.drain();
      off();
    },
    async close() {
      if (ownsEngine) await engine.close();
    },
  };
}

export function httpTrova(port: number, token: string): Trova {
  const base = `http://127.0.0.1:${port}`;
  const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Request-Id": crypto.randomUUID() });
  const fail = async (res: Response): Promise<never> => {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new EngineError(body?.error.code ?? "internal", body?.error.message ?? `HTTP ${res.status}`, body?.error.retryable ?? false);
  };
  const trova: Trova = {
    local: false,
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
      if (!res.ok) await fail(res);
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    },
    async *stream(path, body, signal) {
      const res = await fetch(base + path, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
      if (!res.ok || !res.body) await fail(res);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const value = JSON.parse(line) as ResultBatch & Partial<ErrorBody>;
          if (value.error && !value.stage) throw new EngineError(value.error.code, value.error.message, value.error.retryable);
          yield value;
        }
      }
    },
    async wait(onProgress) {
      for (;;) {
        const status = await trova.json<{ jobs: { kind: string; done: number; total: number }[] }>("GET", "/v1/index/status");
        if (status.jobs.length === 0) return;
        const job = status.jobs[0]!;
        onProgress?.(job.kind, job.done, job.total);
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    async close() {},
  };
  return trova;
}

export async function daemonTrova(home = trovaHome()): Promise<Trova | null> {
  const info = readDaemonInfo(home);
  if (!info) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return httpTrova(info.port, info.token);
}

/** Connects to the running daemon, or opens the engine in-process when there is none. */
export async function connect(home = trovaHome()): Promise<Trova> {
  return (await daemonTrova(home)) ?? localTrova(await Engine.open({ home }));
}

/** Connects to the daemon and starts one first when none runs, so every client shares one copy of the models. */
export async function connectOrStartDaemon(home = trovaHome(), cliPath = process.argv[1]!): Promise<Trova> {
  const running = await daemonTrova(home);
  if (running) return running;
  const child = spawn(process.execPath, [cliPath, "watch"], { detached: true, stdio: "ignore", env: { ...process.env, TROVA_HOME: home } });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const trova = await daemonTrova(home);
    if (trova) return trova;
  }
  return localTrova(await Engine.open({ home }));
}
