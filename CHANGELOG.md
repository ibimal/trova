# Changelog

All notable changes to `trova-cli`. Versions follow [semantic versioning](https://semver.org); while below 1.0, a minor version may change commands or output, and these notes say so. [`docs/api.md`](docs/api.md) explains how the HTTP API is versioned.

## 0.1.2 - 2026-11-22

- `GET /health` adds `apis`, the list of API versions the engine serves, so a client can tell an engine that serves several major versions apart from one that serves only a newer one. The HTTP API is now version 1.1.
- `GET /v1/metadata/keys` lists keys and values in key order. Before, a key that continued with a space could come before a shorter key that started the same way.
- The MCP tools `ask` and `related` treat an argument that is not a string as empty, instead of turning it into the text `[object Object]`.
- `trova eval` lists its report rows in group order.
- The package's homepage and repository links point at the repository root.
- The repository is a single package: `src/`, `src/contract/`, `src/eval/` and `test/` replace the former npm workspace, and [Vite+](https://viteplus.dev) provides the build, tests, linting and formatting. The installed package keeps the same files.

## 0.1.1 - 2026-11-22

- The README gains how to update and uninstall the engine.
- `trova --version` and `/health` read the version from `package.json`.
- Removed code that tightened the permissions of a data folder made by a pre-release build, and three unused contract exports.

## 0.1.0 - 2026-11-21

- First release: indexing and keyword, vector and hybrid search over folders of Markdown notes, related notes and blocks, a daemon with an HTTP API on 127.0.0.1, an MCP server, and an evaluation harness. Built on qmd 2.9.0.
