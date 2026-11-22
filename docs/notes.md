# Design notes

The engine implements a written features and API specification that is not published here. These notes record where the engine differs from it and what is not built. `docs/spikes.md` gives the evidence. The plugin's own notes are in its repository, [trova-obsidian](https://github.com/ibimal/trova-obsidian/blob/main/docs/notes.md).

## Deviations from the spec

Each of these is a decision made during the build.

- **Expansions in Deep mode.** The spec puts `expansions` on the first batch. The engine sends them on the `rerank` batch, because the keyword batch is sent before the expansion model has run.
- **Ask keyword pass.** When the all-words query finds fewer than 3 notes, Ask also takes notes that match any content word. A natural-language question rarely has every word in one note.
- **Extra endpoints.** `POST /v1/attachments/text` (OCR text pushed by the plugin), `/v1/duplicates`, `/v1/topics`, `/v1/graph` (the similarity graph around one note), `/v1/models/download`, `/v1/index/pause`, `/v1/index/resume`, `/v1/keepalive`, `/v1/debug`.
- **Typo rescue vocabulary.** FTS5 stores stems. A stem within the allowed edits of a prefix of the typed word counts as a correction.
- **Notes over 2 MB.** qmd indexes a markdown note whole. Such notes are listed under `oversized` in the engine's status, but not cut. Attachment text is cut at 2 MB.

## Not built

- Phase 4: the Rust engine and its WebAssembly build.
- Baseline recordings of Smart Connections, Smart Lookup and Omnisearch, and a query set from a real vault. `trova eval --queries <file>` accepts one.
