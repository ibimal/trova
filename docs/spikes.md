# Spike findings

The specification (not published in this repository) listed four items to verify before building. Three concern the engine and are below; the fourth, Bases custom functions, concerns the Obsidian plugin and is recorded in its repository, [trova-obsidian](https://github.com/ibimal/trova-obsidian/blob/main/docs/notes.md). These are the findings, checked against qmd 2.9.0, the first and only qmd version the engine supports, and Node 24.22.2.

## 1. A second read-only connection can query qmd's vector table

**Confirmed.** `src/reader.ts` opens `qmd.sqlite` with `better-sqlite3` in read-only mode and loads `sqlite-vec`. It runs nearest-neighbour queries (`embedding MATCH ? AND k = ?`) and reads stored vectors while qmd's own connection has the database open and writes to it. The engine tests cover this on every run: they index, embed and query in one process.

Two details matter:

- The vector table, `vectors_by_collection`, does not exist until the first embedding run. The reader checks for it before each vector query. Its layout is under "qmd vector layout" below.
- An `fts5vocab` table can be created in the `temp` schema of a read-only connection. Typo rescue reads the vocabulary that way.

## 2. `fetch` streams a response body with the origin `app://obsidian.md`

**Confirmed.** The server answers preflights, sets `Access-Control-Allow-Origin: app://obsidian.md`, and rejects any other `Origin` with 403. The engine tests read NDJSON and SSE bodies incrementally through `fetch` and abort them mid-stream. The Obsidian plugin's `EngineClient` uses the same `fetch` and `ReadableStream` calls, and it reads the streamed search and Ask results inside Obsidian 1.15.1.

## 3. `searchLex` position data

**`searchLex` gives no match position.** Its result has a score and an optional `chunkPos` only for vector hits. The shim therefore does not call `searchLex`. It builds an FTS5 `MATCH` expression from the parsed query and runs it on the read-only connection with qmd's own weights (`bm25(documents_fts, 1.5, 4.0, 1.0)`). It then locates the matches in the body itself: the block with the most matches becomes the result's block, and the snippet and highlights come from that block.

This also lets the lex lane honour the parsed query exactly: OR-groups, exact words, phrases, `in:title` and exclusions.

## Other findings from the build

| Finding | Detail |
| --- | --- |
| Node version | `better-sqlite3` 13.2.0's prebuilt binary segfaults in `new Database()` on Node 22.12.0 and works on Node 24.22.2. `trova` probes SQLite in a child process before it opens a database, so the user gets a message, not a crash. |
| qmd export map | The package exports only `.` and only for `import`. The adapter resolves the entry with `import.meta.resolve` and loads `llm.js` by file path for `formatQueryForEmbedding`, `formatDocForEmbedding` and `pullModels`. |
| qmd paths | qmd stores the literal relative path. `handelize()` is display-only, so source ids map straight to vault paths. |
| qmd CJK | qmd spaces every CJK character before indexing. The lex lane sends a CJK term as a phrase of single characters. |
| Model selection | `createStore({ config })` makes the config authoritative and writes its collections over the stored ones, so the adapter opens the store without a config and selects the embedding model through `QMD_EMBED_MODEL`, which qmd reads when no config names a model. |
| qmd vector layout | qmd stores each chunk's vector once per collection that holds it: `vectors_by_collection` is a `vec0` table partitioned by an integer `collection_id`, its rowid is the id of a `vector_rows` row (`hash`, `seq`, `collection_id`), and `vector_collection_ids` maps the ids to names. The reader scans each requested collection on its own, as qmd does, so a small collection is not crowded out by a large one, and it counts a chunk held by two collections once. |
| Model presence | `modelExists()` answers true for every `hf:` URI. The adapter checks qmd's model cache folder for the file instead. |
| Deep cold start | On the first Deep query the expansion and rerank models load, which can pass the deadline: 5 seconds by default in the engine, and the plugin's "Deep time limit" setting (15 seconds by default) for searches from Obsidian. The engine then returns the fused results with the note "rerank skipped", and the plugin offers "Rerank now". |
| pdfjs-dist 6 | `destroy()` is on the loading task, not on the document. |

## Measured on the fixture vault

`trova eval --real` on the 201-source fixture vault with qmd's default models: Ask nDCG@10 0.991, Instant nDCG@10 0.998, Connections Recall@20 0.886. These numbers come from generated notes with strongly separated topics, so they show that the pipeline works; they are not evidence about a real vault.
