import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuery, type ResultBatch } from "../src/contract/index.js";
import { writeFixtureVault, type Fixture } from "../src/eval/fixture.js";
import { Engine, type EngineOptions } from "../src/engine.js";
import { fakeDeep, hashEmbedder } from "../src/testing.js";

export const COLLECTION = "vault-test0001";

export interface TestEnv {
  engine: Engine;
  fixture: Fixture;
  home: string;
  vault: string;
  cleanup(): Promise<void>;
}

export async function makeEnv(opts: Omit<Partial<EngineOptions>, "deep"> & { deep?: ReturnType<typeof fakeDeep> | null; index?: boolean } = {}): Promise<TestEnv> {
  const root = mkdtempSync(join(tmpdir(), "trova-test-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  const fixture = writeFixtureVault(vault);
  const engine = await Engine.open({
    home,
    ...(opts as Partial<EngineOptions>),
    embedder: hashEmbedder(),
    deep: opts.deep === null ? undefined : (opts.deep ?? fakeDeep()),
  });
  await engine.addCollection({ name: COLLECTION, path: vault, options: { kind: "vault", exclude: ["Templates"] } });
  if (opts.index !== false) {
    engine.sync({ collection: COLLECTION, full: true });
    await engine.drain();
  }
  return {
    engine,
    fixture,
    home,
    vault,
    cleanup: async () => {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const q = (raw: string) => parseQuery(raw).query;

export async function collect(gen: AsyncIterable<ResultBatch>): Promise<ResultBatch[]> {
  const out: ResultBatch[] = [];
  for await (const batch of gen) out.push(batch);
  return out;
}
