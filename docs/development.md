# Development

## Layout

| Path | Contents |
| --- | --- |
| `bin/trova` | The command's entry point. It loads `dist/cli.js`. |
| `src/` | The engine: CLI, HTTP server, qmd adapter, sidecar database, watcher, jobs and MCP server. |
| `src/contract/` | The `/v1` contract: API types, the query parser, ranking constants, and the block and id rules. No runtime dependencies. |
| `src/eval/` | The fixture vault and the evaluation harness behind `trova eval`. |
| `test/` | Engine, contract and hardening tests, and a contract test that checks the parts of qmd the engine relies on. |
| `build.mjs` | Bundles `src/` into `dist/cli.js` with esbuild. The dependencies stay external. |

The Obsidian plugin, [trova-obsidian](https://github.com/ibimal/trova-obsidian), keeps a copy of `src/contract/` at the same path. Keep the two folders identical: copy any change across.

## Build and test

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run typecheck
```

To run the `trova` command from this checkout instead of the published package:

```bash
npm link
```

`trova eval` runs the evaluation on the fixture vault with a stand-in embedder; `trova eval --real` uses the real models; `trova eval --perf` measures the engine-side latency budgets on a generated 10,000-note vault. GitHub Actions run the type check, the tests and the build on every push.

## Release

1. Set the new version in `package.json`. The CLI and `/health` read it from there.
2. Commit and push.
3. Publish from the repository root. `prepublishOnly` builds `dist/` first:

   ```bash
   npm publish
   ```
