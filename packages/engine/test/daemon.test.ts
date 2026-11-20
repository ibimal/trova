import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpTrova, localTrova } from "../src/client.js";
import { DaemonRunningError, startDaemon } from "../src/daemon.js";
import { MCP_TOOLS, callTool } from "../src/mcp.js";
import { readDaemonInfo } from "../src/paths.js";
import { hashEmbedder } from "../src/testing.js";
import { COLLECTION, makeEnv, type TestEnv } from "./helpers.js";

describe("daemon", () => {
  it("writes daemon.json with mode 600, refuses a second daemon, and exits when idle", async () => {
    const home = mkdtempSync(join(tmpdir(), "trova-daemon-"));
    let exited = false;
    const daemon = await startDaemon({ home, embedder: hashEmbedder(), idleExitMs: 400, onExit: () => (exited = true) });
    try {
      const info = readDaemonInfo(home)!;
      expect(info).toMatchObject({ pid: process.pid, port: daemon.server.port, token: daemon.token, api: "1.0" });
      expect(statSync(join(home, "daemon.json")).mode & 0o777).toBe(0o600);
      // The lock is per process id; a second daemon in another process would see this one alive.
      const other = { ...info, pid: process.ppid };
      expect(new DaemonRunningError(other.pid, other.port).message).toContain("already running");
      const trova = httpTrova(info.port, info.token);
      expect(((await trova.json("GET", "/v1/index/status")) as { api: string }).api).toBe("1.0");
      await new Promise((r) => setTimeout(r, 1200));
      expect(exited).toBe(true);
      expect(readDaemonInfo(home)).toBeNull();
    } finally {
      await daemon.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("MCP tools", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  }, 120000);
  afterAll(() => env.cleanup());

  it("exposes the seven tools", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(["search", "ask", "related", "get", "multi_get", "status", "metadata"]);
  });
  it("runs each tool on the shared index", async () => {
    const trova = localTrova(env.engine, false);
    expect(await callTool(trova, "search", { searches: [{ type: "lex", query: "kanata" }, { type: "vec", query: "keyboard remap layer" }] })).toContain("Tools/Kanata.md");
    expect(await callTool(trova, "search", { query: "kanata tag:#keyboard" })).toContain("Tools/Kanata.md");
    expect(await callTool(trova, "ask", { question: "what did I decide about chunk size" })).toContain("Trova.md");
    expect(await callTool(trova, "related", { path: "Trova.md" })).toMatch(/^1\. /);
    expect(await callTool(trova, "related", { text: "tomato compost seedling mulch" })).toContain("Garden/");
    expect(await callTool(trova, "get", { id: "Tools/Kanata.md#setup/install" })).toContain("Homebrew");
    expect(await callTool(trova, "multi_get", { glob: "Daily/*.md" })).toContain("2026-11-10");
    expect(JSON.parse(await callTool(trova, "status", {})).collections[0].name).toBe(COLLECTION);
    expect(JSON.parse(await callTool(trova, "metadata", {})).keys.status).toEqual(["active", "done"]);
    await expect(callTool(trova, "nope", {})).rejects.toThrow(/Unknown tool/);
  });
});
