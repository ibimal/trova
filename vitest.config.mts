import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./packages/plugin/test/obsidian-mock.ts", import.meta.url)),
    },
  },
});
