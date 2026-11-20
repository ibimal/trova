// The daemon: one per machine. It writes daemon.json (mode 600) with its port and token, serves
// the /v1 contract, and exits by itself after 30 minutes with no connected client and no job.

import { randomBytes } from "node:crypto";
import { API_VERSION } from "@trova/contract";
import { Engine, type EngineOptions } from "./engine.js";
import { ENGINE_VERSION, isProcessAlive, trovaHome, readDaemonInfo, removeDaemonInfo, writeDaemonInfo } from "./paths.js";
import { startServer, type RunningServer } from "./server.js";

export const IDLE_EXIT_MS = 30 * 60 * 1000;

export interface DaemonOptions extends EngineOptions {
  port?: number;
  debug?: boolean;
  idleExitMs?: number;
  /** Called after the daemon has shut down by itself. The CLI exits the process here. */
  onExit?: () => void;
}

export interface Daemon {
  engine: Engine;
  server: RunningServer;
  token: string;
  stop(): Promise<void>;
}

export class DaemonRunningError extends Error {
  constructor(public pid: number, public port: number) {
    super(`A trova daemon is already running (pid ${pid}, port ${port})`);
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const home = opts.home ?? trovaHome();
  const existing = readDaemonInfo(home);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid) && (await healthy(existing.port))) {
    throw new DaemonRunningError(existing.pid, existing.port);
  }
  const engine = await Engine.open({ ...opts, home });
  const token = randomBytes(24).toString("hex");
  const server = await startServer(engine, { token, port: opts.port, debug: opts.debug ?? process.env.TROVA_DEBUG === "1" });
  writeDaemonInfo({ pid: process.pid, port: server.port, token, version: ENGINE_VERSION, api: API_VERSION }, home);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(idleTimer);
    const info = readDaemonInfo(home);
    if (info?.pid === process.pid) removeDaemonInfo(home);
    await server.close();
    await engine.close();
  };
  const idleMs = opts.idleExitMs ?? IDLE_EXIT_MS;
  const idleTimer = setInterval(
    () => {
      if (server.clients() > 0 || engine.jobs.active().length > 0) {
        engine.lastActivity = Date.now();
        return;
      }
      if (Date.now() - engine.lastActivity >= idleMs) void stop().then(() => opts.onExit?.());
    },
    Math.min(60_000, Math.max(50, idleMs / 4)),
  );
  idleTimer.unref();
  return { engine, server, token, stop };
}
