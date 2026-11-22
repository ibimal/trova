// Transport-neutral routing for the /v1 contract. The HTTP server and the in-process client of
// the CLI both call `dispatch`, so a command behaves the same with or without a running daemon.

import { EngineError, type ResultBatch } from "./contract/index.js";
import type { Engine } from "./engine.js";

export type Dispatched =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "stream"; batches: AsyncGenerator<ResultBatch> }
  | { kind: "empty"; status: number };

export async function dispatch(
  engine: Engine,
  method: string,
  path: string,
  body: Record<string, unknown>,
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<Dispatched> {
  const b = body as never;
  const json = (value: unknown, status = 200): Dispatched => ({
    kind: "json",
    status,
    body: value,
  });
  switch (`${method} ${path}`) {
    case "POST /v1/search":
      return { kind: "stream", batches: engine.search(b, signal) };
    case "POST /v1/ask":
      return { kind: "stream", batches: engine.ask(b, signal) };
    case "POST /v1/related":
      return json(await engine.related(b, signal));
    case "POST /v1/graph":
      return json(await engine.graph(b, signal));
    case "POST /v1/vocab/suggest":
      return json(engine.vocabSuggest(b));
    case "POST /v1/score":
      return json(await engine.score(b));
    case "POST /v1/documents/get":
      return json(engine.get(b));
    case "POST /v1/documents/multi-get":
      return json(engine.multiGet(b));
    case "POST /v1/index/sync":
      if (typeof body["collection"] !== "string")
        throw new EngineError("bad_request", "The request needs a collection");
      return json(engine.sync(b), 202);
    case "GET /v1/index/status":
      return json(engine.status());
    case "POST /v1/index/pause":
      engine.pause();
      return json({ paused: true });
    case "POST /v1/index/resume":
      await engine.resume();
      return json({ paused: false });
    case "GET /v1/collections":
      return json({ collections: await engine.listCollections() });
    case "POST /v1/collections":
      if (typeof body["rename"] === "string" && typeof body["name"] === "string") {
        await engine.renameCollection(body["name"], body["rename"]);
        return json({ collections: await engine.listCollections() });
      }
      if (typeof body["contextPath"] === "string" && typeof body["name"] === "string") {
        await engine.setContext(
          body["name"],
          body["contextPath"],
          typeof body["contextText"] === "string" ? body["contextText"] : null,
        );
        return json({ collections: await engine.listCollections() });
      }
      return json(await engine.addCollection(b));
    case "DELETE /v1/collections": {
      const name = params.get("name") ?? (body["name"] as string | undefined);
      if (!name) throw new EngineError("bad_request", "The request needs a collection name");
      await engine.removeCollection(name);
      return { kind: "empty", status: 204 };
    }
    case "GET /v1/metadata/keys":
      return json(engine.metadataKeys(params.getAll("collection")));
    case "POST /v1/attachments/text":
      return json(engine.attachmentText(b), 202);
    case "GET /v1/duplicates":
      return json(engine.getDuplicates(false));
    case "POST /v1/duplicates":
      return json(engine.getDuplicates(true), 202);
    case "GET /v1/topics":
      return json(engine.getTopics(false));
    case "POST /v1/topics":
      return json(engine.getTopics(true), 202);
    case "POST /v1/models/download":
      return json(engine.downloadModels(), 202);
    case "POST /v1/keepalive":
      engine.keepWarm();
      return json({ ok: true });
  }
  const cancel = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(path);
  if (cancel && method === "POST") {
    engine.cancelJob(decodeURIComponent(cancel[1]!));
    return { kind: "empty", status: 204 };
  }
  throw new EngineError("not_found", `No route for ${method} ${path}`);
}
