import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo } from "@trova/contract";
import pkg from "../package.json" with { type: "json" };

export const ENGINE_NAME = "trova";
/** The version in package.json, so the CLI, /health and the npm package always agree. */
export const ENGINE_VERSION: string = pkg.version;

const DEFAULT_HOME = join(homedir(), ".cache", "trova");

/** The engine's data directory: `~/.cache/trova`, or `TROVA_HOME` when set. */
export function trovaHome(): string {
  return process.env.TROVA_HOME || DEFAULT_HOME;
}

export interface DataPaths {
  home: string;
  qmdDb: string;
  sidecarDb: string;
  daemonJson: string;
  logs: string;
  attachments: string;
}

export function dataPaths(home = trovaHome()): DataPaths {
  // The folder holds note text (index, attachment text, logs), so a new folder is private to the
  // user. An existing folder, such as one chosen with TROVA_HOME, keeps the permissions it has.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "attachments"), { recursive: true, mode: 0o700 });
  return {
    home,
    qmdDb: join(home, "qmd.sqlite"),
    sidecarDb: join(home, "trova.sqlite"),
    daemonJson: join(home, "daemon.json"),
    logs: join(home, "logs"),
    attachments: join(home, "attachments"),
  };
}

export function readDaemonInfo(home = trovaHome()): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")) as DaemonInfo;
    return typeof info.port === "number" && typeof info.token === "string" ? info : null;
  } catch {
    return null;
  }
}

/**
 * Writes daemon.json through a new temporary file, so the token is never readable by other users,
 * even for an instant, and a reader never sees half a file.
 */
export function writeDaemonInfo(info: DaemonInfo, home = trovaHome()): void {
  const file = join(home, "daemon.json");
  const temp = `${file}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, JSON.stringify(info, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
}

export function removeDaemonInfo(home = trovaHome()): void {
  const file = join(home, "daemon.json");
  if (existsSync(file)) rmSync(file, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
