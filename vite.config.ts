import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  // `vp pack` bundles the CLI into dist/cli.js. The dependencies stay external and are installed
  // from package.json; native ones (better-sqlite3, sqlite-vec, node-llama-cpp) cannot be bundled.
  pack: {
    entry: { cli: "src/cli.ts" },
    format: "esm",
    platform: "node",
    target: "node22",
    outDir: "dist",
    clean: true,
    dts: false,
    sourcemap: false,
    // The package is ESM ("type": "module"), so the bundle keeps the .js name that bin/trova loads.
    fixedExtension: false,
  },
});
