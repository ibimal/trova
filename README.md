# Trova

Trova is local keyword and semantic search for folders of Markdown notes. The `trova` command indexes a folder on your machine and searches it by keyword, by meaning, or both. It also serves the index over an HTTP API and to AI agents over MCP. It is built on [qmd](https://github.com/tobi/qmd). Your notes never leave the machine: the only network traffic is the model download from Hugging Face. The models have their own licences, listed in [`packages/engine/README.md`](packages/engine/README.md#models); the default embedding model, EmbeddingGemma, is under Google's Gemma Terms of Use.

```bash
npm install -g trova-cli
```

```bash
trova collection add ~/Notes
```

```bash
trova query "how did we choose the chunk size?"
```

[`packages/engine/README.md`](packages/engine/README.md) documents the command-line tool, the daemon, MCP and where data lives; it is also the package's page on npm. The Obsidian plugin that uses this engine lives in its own repository, [trova-obsidian](https://github.com/ibimal/trova-obsidian).

This repository implements a written features and API specification that is not published here. "Deviations from the spec" below records where the engine differs from it, and `docs/spikes.md` records what was checked before and during the build.

## Layout

| Package | Contents |
| --- | --- |
| `packages/contract` | Types for the `/v1` API, the query parser, ranking constants, block and id rules. No runtime dependencies. The Obsidian plugin keeps a copy. |
| `packages/engine` | `trova-cli`: CLI, HTTP server, qmd adapter, sidecar database, watcher, jobs, MCP server. |
| `packages/eval` | The fixture vault generator and the evaluation harness behind `trova eval`. |

## Requirements

- Node 22 or later; Node 24 is the verified version. On Node 22.12.0 the prebuilt `better-sqlite3` binary crashes, so `trova` stops with a message there; `npm rebuild better-sqlite3 --build-from-source` may fix it. `trova doctor` checks this.

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
npm link -w packages/engine
```

`trova eval` runs the evaluation on the fixture vault with a stand-in embedder; `trova eval --real` uses the real models; `trova eval --perf` measures the engine-side latency budgets on a generated 10,000-note vault.

## Deviations from the spec

Each of these is a decision made during the build. `docs/spikes.md` gives the evidence. The plugin's own deviations are recorded in its repository.

- **Expansions in Deep mode.** The spec puts `expansions` on the first batch. The engine sends them on the `rerank` batch, because the keyword batch is sent before the expansion model has run.
- **Ask keyword pass.** When the all-words query finds fewer than 3 notes, Ask also takes notes that match any content word. A natural-language question rarely has every word in one note.
- **Extra endpoints.** `POST /v1/attachments/text` (OCR text pushed by the plugin), `/v1/duplicates`, `/v1/topics`, `/v1/graph` (the similarity graph around one note), `/v1/models/download`, `/v1/index/pause`, `/v1/index/resume`, `/v1/keepalive`, `/v1/debug`.
- **Typo rescue vocabulary.** FTS5 stores stems. A stem within the allowed edits of a prefix of the typed word counts as a correction.
- **Notes over 2 MB.** qmd indexes a markdown note whole. Such notes are flagged in the status popover but not cut. Attachment text is cut at 2 MB.

## Not built

- Phase 4: the Rust engine and its WebAssembly build.
- Baseline recordings of Smart Connections, Smart Lookup and Omnisearch, and a query set from a real vault. `trova eval --queries <file>` accepts one.

## Licence

MIT; see `LICENSE`. Search and indexing come from [qmd](https://github.com/tobi/qmd) by Tobi Lütke (MIT), a dependency. No code is copied from qmd, Smart Connections or Omnisearch.
