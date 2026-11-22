# Development

## Layout

| Path             | Contents                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `bin/trova`      | The command's entry point. It loads `dist/cli.js`.                                                                            |
| `src/`           | The engine: CLI, HTTP server, qmd adapter, sidecar database, watcher, jobs and MCP server.                                    |
| `src/contract/`  | The `/v1` contract: API types, the query parser, ranking constants, and the block and id rules. No runtime dependencies.      |
| `src/eval/`      | The fixture vault and the evaluation harness behind `trova eval`.                                                             |
| `test/`          | Engine, contract and hardening tests, and a contract test that checks the parts of qmd the engine relies on.                  |
| `vite.config.ts` | The [Vite+](https://viteplus.dev) configuration: tests (Vitest), packaging (tsdown), linting (Oxlint) and formatting (Oxfmt). |

The Obsidian plugin, [trova-obsidian](https://github.com/ibimal/trova-obsidian), keeps a copy of `src/contract/` and `test/contract.test.ts` at the same paths. Keep them identical, apart from the contract test's import (`vitest` there), and copy any change across. [`api.md`](api.md) gives the steps for an API change and the versioning rules.

## Build and test

The tools come from [Vite+](https://viteplus.dev), through the `vp` command in the project's dependencies. They need Node 22.18 or later (or 24.11 or later) for development; the published package still runs on Node 22.

```bash
npm install
```

```bash
npm run check
```

```bash
npm test
```

```bash
npm run build
```

`npm run check` runs `vp check` (formatting, Oxlint with type-aware rules, and type errors) and then `tsc`. `npm run format` formats the code with Oxfmt. `npm run build` bundles `src/cli.ts` into `dist/cli.js` with `vp pack`; the dependencies stay external.

To run the `trova` command from this checkout instead of the published package:

```bash
npm link
```

`trova eval` runs the evaluation on the fixture vault with a stand-in embedder; `trova eval --real` uses the real models; `trova eval --perf` measures the engine-side latency budgets on a generated 10,000-note vault. GitHub Actions run the check, the tests and the build on every push.

## Release

1. Set the new version in `package.json`. The CLI and `/health` read it from there.
2. Commit and push.
3. Publish from the repository root. `prepublishOnly` runs the check and builds `dist/` first:

   ```bash
   npm publish
   ```
