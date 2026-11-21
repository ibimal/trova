# Trova

Trova is an Obsidian plugin with four surfaces on one local index: Instant search, a Connections and Ask pane, a Context basket, and Vault care. The engine (`trova-cli`, CLI `trova`) runs on your machine on top of [qmd](https://github.com/tobi/qmd). Your notes never leave the machine: the only network traffic is the model download from Hugging Face. The models have their own licences, listed in `packages/engine/README.md`; the default embedding model, EmbeddingGemma, is under Google's Gemma Terms of Use.

This repository implements a written features and API specification that is not published here. The sections "Deviations from the spec" and "Additions beyond the spec" below record where the build differs from it, and `docs/spikes.md` records what was checked before and during the build. This README covers how to build, install and run it.

## Layout

| Package | Contents |
| --- | --- |
| `packages/contract` | Types for the `/v1` API, the query parser, ranking constants, block and id rules. No runtime dependencies. |
| `packages/engine` | `trova-cli`: CLI, HTTP server, qmd adapter, sidecar database, watcher, jobs, MCP server. |
| `packages/plugin` | The Obsidian plugin. It builds to one `main.js` with the worker inlined. |
| `packages/eval` | The fixture vault generator and the evaluation harness behind `trova eval`. |

## Requirements

- Node 22 or later for the engine; Node 24 is the verified version. On Node 22.12.0 the prebuilt `better-sqlite3` binary crashes, so `trova` stops with a message there; `npm rebuild better-sqlite3 --build-from-source` may fix it. `trova doctor` checks this.
- Obsidian 1.9.0 or later. The Bases view needs 1.10.

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

## Install the engine

Inside this repository:

```bash
npm link -w packages/engine
```

Then check it:

```bash
trova doctor
```

`packages/engine/README.md` documents the command-line tool, and `trova help` lists every command. `trova eval` runs the evaluation on the fixture vault with a stand-in embedder; `trova eval --real` uses the real models; `trova eval --perf` measures the engine-side latency budgets on a generated 10,000-note vault.

The engine runs as one daemon per machine, started by the plugin or by `trova watch`. It listens on 127.0.0.1 only, and every request needs the token it writes to `daemon.json` in its data folder, which only your user account can read. It stops by itself after 30 minutes with no client and no job.

## Use it from an AI agent (MCP)

`trova mcp` serves the index to an MCP client over stdio, with the tools `search`, `ask`, `related`, `get`, `multi_get`, `status` and `metadata`. It uses the running daemon, or starts one, so the models load once. `trova mcp --http` serves the same tools over HTTP at `http://127.0.0.1:8181/mcp` (`--port` changes the port). The HTTP server has no token: it accepts only requests from this machine and refuses any whose `Host` or `Origin` is not a loopback address, so web pages cannot reach it. Any program on this machine, under any user account, can read your notes through it, so start it only while you use it.

## Install the plugin

Copy `packages/plugin/main.js`, `packages/plugin/manifest.json` and `packages/plugin/styles.css` into `<vault>/.obsidian/plugins/trova/`, then enable Trova in Obsidian's community plugin settings. On desktop the plugin starts the engine when the vault opens, so the welcome screen can show what will be indexed and whether the models still need downloading. Nothing is indexed or downloaded until you click Start. "Continue without engine" disconnects the plugin and never starts the engine again; an engine it already started exits by itself after 30 minutes with no client.

Without the engine, Instant search still works from the plugin's own keyword index, and Ask falls back to it. Related notes, Deep search, semantic rows, the similarity graph and the near-duplicate scan need the engine.

## Where data lives

| Data | Location |
| --- | --- |
| Engine index, sidecar tables, logs, attachment text | `~/.cache/trova/` (or `TROVA_HOME`) |
| Models | qmd's model cache, `~/.cache/qmd/models/` |
| Settings, pins, hides, pane filters, folder context, Vault care choices ("Not a duplicate", "Keep unlinked") | The plugin's `data.json`, synced with the vault. The plugin checks it on load; when it repairs damaged entries, it first copies the file to `data.backup-<time>.json` |
| Query history, last-opened times, basket, today's Rediscover pick, pane layout (graph drawer, last Vault care group) | Obsidian local storage, per device |
| State of open tabs: the similarity graph's centre note, size and lock; Vault care's group | Obsidian's workspace layout, per device |

## Deviations from the spec

Each of these is a decision made during the build. `docs/spikes.md` gives the evidence.

- **Bases.** Obsidian's Bases API has no way to register custom functions. `trova_score()` and `trova_related()` ship as a Bases view named "Trova related" with a Score column and a Related column.
- **Expansions in Deep mode.** The spec puts `expansions` on the first batch. The engine sends them on the `rerank` batch, because the keyword batch is sent before the expansion model has run.
- **Ask lives in the Connections pane.** The spec has separate Connections and Ask panes. They share one pane: with an empty search box it lists related notes; a typed question replaces them with answers, and Esc goes back.
- **Ask keyword pass.** When the all-words query finds fewer than 3 notes, Ask also takes notes that match any content word. A natural-language question rarely has every word in one note.
- **Extra endpoints.** `POST /v1/attachments/text` (OCR text pushed by the plugin), `/v1/duplicates`, `/v1/topics`, `/v1/graph` (the similarity graph around one note), `/v1/models/download`, `/v1/index/pause`, `/v1/index/resume`, `/v1/keepalive`, `/v1/debug`.
- **Typo rescue vocabulary.** FTS5 stores stems. A stem within the allowed edits of a prefix of the typed word counts as a correction.
- **Notes over 2 MB.** qmd indexes a markdown note whole. Such notes are flagged in the status popover but not cut. Attachment text is cut at 2 MB.

## Additions beyond the spec

- **Similarity graph.** The command "Open similarity graph" draws the active note, its related notes and the edges between related notes on one canvas. Shift+click expands a note; double-click opens it. The graph holds at most 400 notes. A smaller copy sits in a resizable drawer at the bottom of the Connections pane, with its selection kept in step with the list.
- **Vault care tab.** Near-duplicates, orphans and Rediscover in one editor tab. "Not a duplicate" and "Keep unlinked" are remembered across scans, with Undo and a list to restore them.
- **Where notes open.** Every list and graph follows Obsidian's own rule. A click opens a note in the current tab; with Cmd (Ctrl on Windows and Linux) in a new tab, with Cmd+Alt in a split, and with Cmd+Alt+Shift in a new window. A middle-click opens a new tab. Enter takes the same modifiers in Instant search, the Connections pane, Vault care and the two graphs. The similarity graph, Vault care and the topic map open in the current tab and keep their state in the tab's history, so Back returns to them as they were. To keep one of them in place while notes open beside it, pin its tab.
- **Deep time limit and "Rerank now".** Deep mode's time limit is a setting (15 seconds by default). When a rerank still runs out of time, the pane offers to rerank that question again with a long limit.
- **Topic map on canvas.** The topic map uses the same canvas, so it pans and zooms with thousands of notes.
- **Ask without the engine.** When the engine is off, Ask returns keyword matches from the worker and says so.
- **Query history.** Alt+Up and Alt+Down walk through earlier Instant search queries.
- **Live overlay.** The editor's text reaches the worker 250 ms after the last keystroke, before Obsidian saves the note.

## Not built

- Phase 4: the Rust engine and its WebAssembly build. Mobile therefore runs Instant search from the worker and nothing else.
- The end-to-end layer of the test plan (a scripted Obsidian instance). The plugin's logic is tested with a mocked `obsidian` module. Its views have no automated tests in this repository; they were checked in a running Obsidian.
- Baseline recordings of Smart Connections, Smart Lookup and Omnisearch, and a query set from a real vault. `trova eval --queries <file>` accepts one.

## Licence

MIT; see `LICENSE`. Search and indexing come from [qmd](https://github.com/tobi/qmd) by Tobi Lütke (MIT), a dependency. No code is copied from qmd, Smart Connections or Omnisearch.
