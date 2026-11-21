# trova-cli

Local keyword and semantic search for folders of Markdown notes. `trova` indexes a folder on your machine and searches it by keyword, by meaning, or both. It runs as a command-line tool, an HTTP API and an MCP server for AI agents. It is built on [qmd](https://github.com/tobi/qmd), and nothing leaves the machine except the one-time model download.

The same engine powers the Trova plugin for Obsidian, which lives in the [same repository](https://github.com/ibimal/trova).

## Requirements

- Node 22 or later; Node 24 is the verified version. On Node 22.12.0 the prebuilt `better-sqlite3` binary crashes, so `trova` stops with a message there.
- Checked on macOS on Apple Silicon. Other platforms are not tested yet.

## Install

```bash
npm install -g trova-cli
```

npm 11 does not run the install scripts of dependencies unless you allow them, and it lists the ones it skipped: `node-llama-cpp` and some `tree-sitter` packages. On macOS with Apple Silicon `trova` works without them, because the prebuilt binaries are used. On other platforms `node-llama-cpp` may need its script; this is not tested.

Then check the setup:

```bash
trova doctor
```

## Quick start

Add a folder as a collection. `trova` indexes and embeds it; the first run downloads qmd's embedding model, about 330 MB.

```bash
trova collection add ~/Notes
```

Search it:

```bash
trova search "chunk size"
```

```bash
trova query "how did we choose the chunk size?"
```

`search` is the keyword lane. When a query finds fewer than 3 notes, it corrects misspelt words of 5 letters or more: one edit, or two for words of 9 letters or more. `vsearch` is the vector lane. `query` (alias `ask`) fuses both. `query --mode deep` also expands the query and reranks the results with two larger models, about 1.7 GB together. The command line cannot download them yet; until they are on disk, Deep queries run in Fast mode and say so.

`trova related <path>` lists the notes closest to one note, and `trova related <path>#<heading>` the blocks closest to one section.

## Commands

| Command | What it does |
| --- | --- |
| `collection add <path> [--name <name>]` | Add a folder as a collection and index it |
| `collection ls`, `collection rm <name>`, `collection rename <old> <new>` | List, remove or rename collections |
| `context add <collection> <path> <text>`, `context ls`, `context rm <collection> <path>` | Describe a folder to improve ranking |
| `update [-c <collection>]` | Rescan collections for changes |
| `embed` | Embed new and changed blocks |
| `search`, `vsearch`, `query <query> [--mode fast\|deep]` | Keyword, vector and hybrid search |
| `related <path>[#heading-path]` | Related sources and blocks |
| `get <id\|path>`, `multi-get <glob \| id,id,...>` | Print one source, or several |
| `status`, `doctor` | Health, counts and model identity |
| `watch [--port <n>]` | Run the daemon: watcher, indexer and HTTP API |
| `serve [--port <n>]` | HTTP API only, no watcher |
| `mcp [--http] [--port <n>]` | MCP server over stdio, or over HTTP on 127.0.0.1 |
| `eval` | nDCG@10 and Recall@20 on a fixture vault or your own queries |

Every command takes `--json`, `-n`/`--limit <n>` and `-c`/`--collection <name>`. `trova help` prints the full list.

## The daemon

`trova watch` runs one daemon per machine. It keeps the models loaded, watches the collections for changes and serves the HTTP API on 127.0.0.1 only. Every request needs the token it writes to `daemon.json` in its data folder, which only your user account can read. Other commands use a running daemon when there is one and otherwise run in-process. The daemon stops by itself after 30 minutes with no client and no job.

## Use it from an AI agent (MCP)

`trova mcp` serves the index over stdio with the tools `search`, `ask`, `related`, `get`, `multi_get`, `status` and `metadata`. For a client that reads an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "trova": { "command": "trova", "args": ["mcp"] }
  }
}
```

`trova mcp --http` serves the same tools at `http://127.0.0.1:8181/mcp`. That server has no token: it refuses any request whose `Host` or `Origin` is not a loopback address, so web pages cannot reach it, but any program on this machine can. Start it only while you use it.

## Where data lives

| Data | Location |
| --- | --- |
| Index, sidecar tables, logs, attachment text | `~/.cache/trova/`, or the folder in `TROVA_HOME` |
| Models | qmd's model cache, `~/.cache/qmd/models/` |

## Licence

MIT; see `LICENSE`.
