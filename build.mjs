import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Native and large packages stay external and are installed as dependencies.
  external: ["@tobilu/qmd", "better-sqlite3", "sqlite-vec", "pdfjs-dist", "pdfjs-dist/*", "yaml", "fflate", "picomatch", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"],
  banner: { js: "import { createRequire as __trovaCreateRequire } from 'node:module'; const require = __trovaCreateRequire(import.meta.url);" },
  logLevel: "warning",
});
