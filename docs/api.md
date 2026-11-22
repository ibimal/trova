# API versioning

Trova has three public interfaces. Each one is versioned on its own, so the engine and the Obsidian plugin can be released separately without breaking each other.

| Interface                                                           | Used by                                   | Version                                               |
| ------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| The HTTP API under `/v1`                                            | The Obsidian plugin, and any other client | `API_VERSION` in `src/contract/types.ts`, MAJOR.MINOR |
| The `trova` command's commands, flags and output, and the MCP tools | People, scripts and AI agents             | The `trova-cli` package version, semantic versioning  |
| The Obsidian plugin's settings and commands                         | Obsidian users                            | The plugin's own version, in its repository           |

## The HTTP API

**A minor version only adds.** New endpoints, new optional request fields, new response fields and new capabilities are a minor change: `1.1` becomes `1.2`. A client must ignore response fields it does not know. A feature that an engine may or may not offer is announced in the `capabilities` list of `GET /v1/index/status`, and a client checks it before using the feature; an engine without it answers `unsupported`.

**A major version gets new paths.** Removing or renaming an endpoint or a field, changing a field's type or meaning, or changing an error code is a breaking change. It goes under new paths, `/v2`, with `API_VERSION` set to `2.0`. The engine keeps serving `/v1` next to `/v2` until a plugin release that speaks `/v2` has been available for some time, so a user who updates only one of the two keeps a working setup.

**The handshake.** `GET /health` needs no token and answers with `api`, the newest version the engine serves, and `apis`, every version it serves, one per major. A client connects when `apis` includes its own major version; `apiCompatibility()` in the contract does that check. When it does not, the plugin tells the user which side to update: the engine when its versions are older, the plugin when they are newer. Engines from before API 1.1 send only `api`, and a client treats that as a list of one.

## The contract copy

The Obsidian plugin keeps a copy of `src/contract/` at the same path, with the same `test/contract.test.ts`. Keep the two identical; the contract test differs only in its test import (`vite-plus/test` here, `vitest` in the plugin). Both repositories format with Oxfmt 0.79.0, so the copies keep one layout. An API change therefore goes through these steps:

1. Change `src/contract/` here, and set `API_VERSION`: the next minor for an addition, the next major (with `/v2` paths) for a breaking change.
2. Implement it in the engine, with tests.
3. Copy `src/contract/` and `test/contract.test.ts` to the plugin, and update the plugin.
4. Release the engine first, then the plugin, so the plugin never expects an engine that is not published yet.

## The command line and MCP

`trova-cli` follows semantic versioning. While it is below 1.0, a minor release may change commands, flags or output; the release notes say so. From 1.0, a breaking change to a command, a flag, the `--json` output or an MCP tool needs a new major version.
