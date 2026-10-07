# RAG: ingestion and query with Mastra on PgVector

Retrieval-augmented generation in two units and one package:

| Piece                  | What it does                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `workflows/rag-ingest` | `RagIngest`: indexes documents into a collection (chunk → extract → embed → write), deletes them, or drops it |
| `services/rag-query`   | `RagQuery` (public): search, answer with citations, collections and documents                                 |
| `packages/rag`         | the store: collection registry, document ledger and one Mastra PgVector table per collection                  |
| `apps/core-api`        | the `/v1/rag` routes: reads and queries call `RagQuery`; changes start `RagIngest` runs                       |

```
REST  POST /v1/rag/collections/:c/documents ─┐
      DELETE …/documents/:id · DELETE …/:c ──┼─ core-api ─ startRun ─► RagIngest ─┐
Kafka rag.ingest     (canonical input) ──────┤                                    │
Kafka rag.documents  (mapped by config) ─────┘  RagIngestTrigger                  ▼
                                                                      rag database (Postgres + pgvector)
REST  POST …/search · …/answer                                         rag_collections   (registry)
      GET collections · documents ── core-api ─ ingress call ─► RagQuery   rag_documents     (ledger)
                                                                         vectors."c_<id>"  (chunks)
Models through LiteLLM: embed-qwen3-0p6b (qwen3-embedding:0.6b, 1024-d) · chat-default (qwen3.5:4b)
```

Decisions and their reasons are in [decisions.md](decisions.md) ("RAG with Mastra on PgVector").

## Run it

```sh
ollama pull qwen3-embedding:0.6b                  # the embedding model, on the host
docker compose down -v && docker compose up -d --build   # or apply 30-rag.sql to an existing volume
pnpm pipeline deploy rag-query rag-ingest

# Index two documents (creates the collection on first use) — a 202 with a runId
curl -s localhost:3000/v1/rag/collections/handbook/documents -H 'content-type: application/json' -d '{
  "documents": [
    { "id": "water-cycle", "title": "The water cycle", "format": "markdown",
      "text": "# The water cycle\nHeat from the sun evaporates water…", "metadata": { "subject": "Science", "grade": 7 } },
    { "id": "photosynthesis", "title": "Photosynthesis",
      "text": "Green plants make food from light, water and carbon dioxide…", "metadata": { "subject": "Science", "grade": 7 } }
  ]
}'
pnpm pipeline run rag-ingest <runId>             # per-document statuses once it completes

curl -s localhost:3000/v1/rag/collections/handbook/search -H 'content-type: application/json' \
  -d '{ "query": "why does it rain?", "topK": 3, "filter": { "subject": "Science" } }'
curl -s localhost:3000/v1/rag/collections/handbook/answer -H 'content-type: application/json' \
  -d '{ "question": "What do plants need to make food?" }'

# Kafka: a producer's own event shape, mapped by `eventMappings.documentEvent`
echo '{"type":"document","id":"clouds","title":"Clouds","body":"Clouds are droplets…","lang":"en","tags":["weather"]}' | \
  docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic rag.documents
```

## Ingestion: `RagIngest`

A run has one of three operations:

- `upsert`:
  ```json
  {
    "operation": "upsert",
    "collection": "…",
    "documents": [ … ],
    "options": { … },
    "collectionSettings": { … }
  }
  ```
  `options` and `collectionSettings` are optional.
- `delete`: `{ "operation": "delete", "collection": "…", "documentIds": [ … ], "version": n }`
  (`version` is optional; see [Ordering](#ordering-and-why-concurrent-runs-are-safe))
- `drop`: `{ "operation": "drop", "collection": "…" }`

You can start a run in three ways:

- through core-api's `/v1/rag` routes, which wrap these;
- with `POST /v1/workflows/rag-ingest/runs` and an explicit `{ input }`;
- from Kafka.

**What a run does:**

1. It plans the run, checking every rule a JSON Schema cannot state. A violation fails the run with
   a 400 before anything is written. These rules are:
   - document ids are unique;
   - no document's metadata uses a key the pipeline writes itself;
   - templates contain their placeholders;
   - chunking sizes fit together.
2. `collection.ensure` creates the collection on first use, with this run's settings over the
   defaults. It probes the embedding dimension once. If the collection already exists and the run
   gave explicit settings, they must match exactly (409 otherwise).
3. Each document is one durable step, run `limits.documentConcurrency` at a time:
   1. Settle it as `unchanged` if its fingerprint has not changed. The fingerprint covers the text,
      format, title, metadata, chunking, extraction, embedding template and model.
   2. Otherwise chunk it with Mastra's `MDocument`.
   3. Optionally extract metadata.
   4. Embed each chunk's `documentTemplate` rendering.
   5. Write the vectors and the ledger in one transaction.

   A document that fails for good does not fail the others.

**Per-document statuses:**

| Status       | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `written`    | this run wrote the document (or recognised its own earlier write on a retry)      |
| `unchanged`  | same fingerprint as what is indexed; nothing re-embedded, its order moved forward |
| `superseded` | a newer version is already indexed (or deleted); this one was dropped             |
| `deleted`    | removed by a `delete`                                                             |
| `absent`     | a `delete` of something not indexed (the tombstone is still recorded)             |
| `failed`     | not indexable (no text, too many chunks, a model refusal…); `error` says why      |

### Ordering, and why concurrent runs are safe

Every write and delete carries an order key: the document's `version` if it has one (a
non-negative integer; for a delete, the run's `version`), else the time the run was received
(`trigger.receivedAt`). The run id breaks
ties. Within a document, the store keeps whichever is newest, whatever order the runs land in:

- an older write that lands later is `superseded`;
- an unchanged re-send moves the order forward, so a delayed older edit still loses;
- a delete leaves a tombstone, so a late older write cannot bring the document back.

**Within one collection, send `version` always or never — deletes included.** Version numbers and
receive times are different scales: a delete without a version is ordered by its receive time, which
is far above any small version number, so the document could not be indexed again with one. A
producer that versions its documents passes the deletion's version (`?version=` on the REST route; a
mapping's `version` path on Kafka).

### Documents

| Field      | Type                                                  | Notes                                                                                |
| ---------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`       | string, 1–512, no control characters                  | the producer's id; unique within the collection                                      |
| `text`     | string, ≤ 1,000,000 characters                        | inline content (≤ 1 MiB per request through core-api)                                |
| `format`   | `text` (default), `markdown`, `html`, `json`, `latex` | picks Mastra's `MDocument` factory, and the default chunk separators                 |
| `title`    | string                                                | stored on every chunk, and `{title}` in the document template                        |
| `metadata` | `{ key: scalar \| scalar[] }`                         | on every chunk; filterable. Keys: identifiers, ≤ 63 characters, not reserved (below) |
| `version`  | integer ≥ 0                                           | the document's order key                                                             |

A run's documents together carry at most 2,000,000 characters of text; above that the run is
refused with a 400, before anything is written. Postgres cannot store a NUL character or an unpaired
UTF-16 surrogate, so the store drops NULs and replaces unpaired surrogates with U+FFFD in ids, text,
titles and metadata.

Reserved chunk metadata, written by the pipeline: `documentId`, `chunkIndex`, `chunkCount`, `text`,
`title`, `format`, `fingerprint`, `seq`. Chunks also carry Mastra's own metadata (`h1`, `startIndex`,
`tokenCount`, `xpath`…) and any extracted fields.

### Collection settings — fixed for life

Given as `collectionSettings` on the run that creates the collection, or taken from
`config.defaults.collection`. A later run that passes `collectionSettings` must match them exactly.
Changing them means a new collection, or a drop followed by re-ingestion.

| Setting                           | Default                       | Notes                                                                                                             |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `embedding.model`                 | `embed-qwen3-0p6b`            | a LiteLLM `model_name`. **Name an immutable alias**: the collection is bound to it                                |
| `embedding.dimensions`            | probed                        | only for models that can truncate (Matryoshka); the model must return exactly this                                |
| `embedding.queryTemplate`         | `Instruct: …\nQuery: {query}` | what a query embeds as; must contain `{query}` (qwen3-embedding is instruction-tuned for queries)                 |
| `embedding.documentTemplate`      | `{title}\n\n{text}`           | what a chunk embeds as; must contain `{text}`; may use `{title}` and any chunk metadata key (`{excerptKeywords}`) |
| `index.metric`                    | `cosine`                      | `cosine`, `euclidean`, `dotproduct` (`flat` takes `cosine` only)                                                  |
| `index.type`                      | `hnsw`                        | `hnsw`, or `flat` (no index: exact scans, fine when small). IVFFlat is not offered                                |
| `index.hnsw.m`, `.efConstruction` | `16`, `64`                    | HNSW build parameters                                                                                             |
| `index.vectorType`                | `vector`                      | `halfvec` halves storage; HNSW indexes up to 2000 (`vector`) or 4000 (`halfvec`) dimensions                       |
| `index.metadataIndexes`           | `[]`                          | metadata keys to b-tree index (`documentId` always is); speeds up equality filters                                |
| `description`                     | `""`                          |                                                                                                                   |

PgVector reads a collection's metric back from its vector index. A `flat` collection has none, so
it would always be searched by cosine; `flat` with another metric is refused.

### Run options

`options.chunking` is applied, as given, to every document in the run.

Without it, a document gets `config.defaults.chunking`: recursive splitting, `maxSize` 1500,
`overlap` 150. When that default is the recursive splitter with no separators of its own, it uses the
format's own separators: Markdown headings, HTML blocks, LaTeX sections.

`separatorPosition` defaults to `start`, so a split's separator stays with the chunk it starts.

**Every strategy takes the base options:**

| Option              | Notes                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `maxSize`           | characters (tokens for `token`). Mastra's default is 4000                                          |
| `overlap`           | must be below `maxSize`. Mastra's default is 200, so a `maxSize` ≤ 200 needs an explicit `overlap` |
| `separatorPosition` | `start` or `end`                                                                                   |
| `addStartIndex`     | adds `metadata.startIndex`, the chunk's offset in the source                                       |
| `stripWhitespace`   |                                                                                                    |

**Extra options by strategy:**

| `strategy`          | Extra options                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `recursive`         | `separators`, `isSeparatorRegex`, `language` (one of 26; replaces `separators`)                                                   |
| `character`         | `separator`, `isSeparatorRegex` — one chunk per piece; pieces are not merged                                                      |
| `token`             | `encodingName` (`cl100k_base`…), `modelName`, `allowedSpecial` / `disallowedSpecial` (`"all"` or a list)                          |
| `markdown`          | `headers` (`[["#","h1"],["##","h2"]]`: split on headings only, heading text into metadata), `returnEachLine`, `stripHeaders`      |
| `semantic-markdown` | `joinThreshold` (tokens; merges small sections; never splits large ones), tiktoken options                                        |
| `html`              | exactly one of `headers` and `sections` (`[["h1","h1"]]`), `returnEachLine`; `maxSize` adds a recursive pass                      |
| `json`              | `maxSize` (required), `minSize`, `ensureAscii`, `convertLists` — the document must be valid JSON                                  |
| `latex`             | the base options only                                                                                                             |
| `sentence`          | `maxSize` (required), `targetSize`, `sentenceEnders`, `fallbackToWords`, `fallbackToCharacters`; `overlap` counts whole sentences |

Mastra validates each strategy's options strictly, and so does the contract. `lengthFunction` is not
offered, because a function cannot travel in JSON.

**`options.extract`** turns on Mastra's metadata extractors. Each makes an LLM call per chunk, so
they are opt-in and capped:

| Extractor   | Options                                                          | Writes                                                       |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `title`     | `nodes` (5), `nodeTemplate`, `combineTemplate`                   | `documentTitle`, inferred once from the first `nodes` chunks |
| `summary`   | `summaries` (`self`/`prev`/`next`; `["self"]`), `promptTemplate` | `sectionSummary`, `prevSectionSummary`, `nextSectionSummary` |
| `questions` | `questions` (5), `promptTemplate`                                | `questionsThisExcerptCanAnswer`                              |
| `keywords`  | `keywords` (5), `promptTemplate`                                 | `excerptKeywords`                                            |

**Common to all extractors:**

- `model` defaults to `defaults.extractModel` (`chat-default`).
- `batchSize` (default 4) is how many chunks go to Mastra at once, and so the most LLM calls in
  flight.
- A document with more than `limits.maxExtractChunks` (64) chunks fails rather than run an extraction
  long enough to hit Restate's abort window.
- Extracted fields are filterable, and can go into `documentTemplate`.

**Other run options:**

- `options.embedding.batchSize`: values per embedding call (default 32).
- `options.force`: re-index even unchanged documents.

### Unit config (`metadata.json`)

| Key                           | Default            | Meaning                                                 |
| ----------------------------- | ------------------ | ------------------------------------------------------- |
| `defaults.collection`         | see above          | settings a new collection gets                          |
| `defaults.chunking`           | recursive 1500/150 | chunking when a run gives none                          |
| `defaults.extractModel`       | `chat-default`     | extraction model when a run names none                  |
| `defaults.embeddingBatchSize` | `32`               |                                                         |
| `limits.documentConcurrency`  | `4`                | document steps in flight per run                        |
| `limits.maxChunksPerDocument` | `2000`             | bounds one document's step; above it the document fails |
| `limits.maxExtractChunks`     | `64`               |                                                         |
| `eventMappings`               | `documentEvent`    | Kafka adapters, below                                   |

Changing `metadata.json` is a new artifact: bump `version` (or `--dev`).

### Kafka: the topic and the event shape are configuration

`metadata.json` declares two Kafka triggers:

- `ingest` on `rag.ingest`, with no adapter. A record is a canonical `RagIngestInput`.
- `documents` on `rag.documents`, with `adapter: "documentEvent"`. A record is a producer's own
  event, mapped by `config.eventMappings.documentEvent`.

**Adding a source** takes four steps: add a topic to `kafka-init`, add a trigger naming a mapping,
add the mapping, then bump the version. A trigger naming a missing mapping fails at boot.

```jsonc
"eventMappings": {
  "contentPublished": {
    "collection": "diksha_content",
    "when": [{ "path": "eid", "equals": "BE_JOB_REQUEST" }, { "path": "edata.status", "in": ["Live"] }],
    "deleteWhen": [{ "path": "edata.status", "equals": "Retired" }],
    "documentId": "edata.identifier",
    "text": ["edata.name", "edata.description", "edata.body"],
    "title": "edata.name",
    "version": "ets",
    "format": "text",
    "metadata": { "channel": "edata.channel", "subject": "edata.subject", "medium": "edata.medium" },
    "options": { "chunking": { "strategy": "recursive", "maxSize": 1200, "overlap": 120 } }
  }
}
```

**Paths** are dot paths with `[n]` for array elements. **Conditions** are `equals`, `in` and `exists`.

**Outcomes:**

- if `when` does not hold, the event is skipped with no run (it was never this mapping's business);
- a missing id or no text at any `text` path fails the record terminally, because the event is ours
  but broken — the partition is not blocked;
- if `deleteWhen` holds, the document is deleted, ordered by the event's `version` when the
  mapping has one.

**What is kept:**

- `text` paths are joined with blank lines; missing ones are skipped;
- metadata keeps scalars and arrays of scalars;
- `version` may be an integer or an ISO date, which becomes epoch milliseconds.

The run id derives from the record's coordinates, so a redelivered record joins its original run.

## Queries: `RagQuery` behind `/v1/rag`

core-api checks the path parameters, the query string (an unknown parameter is refused), and that a
body is a JSON object nested at most 64 levels deep (at most 64 KiB for a search or an answer). It
passes the request to `RagQuery`, which validates it in full. A DELETE takes no body.

Reads and searches time out after `RAG_QUERY_TIMEOUT_MS` (30 s); answers, and searches with a
`rerank`, after `RAG_ANSWER_TIMEOUT_MS` (240 s). Both are at most 290,000: Node's `fetch` stops
waiting for a response's headers at 300 s, so a larger value is refused at boot. A timeout ends
the wait, not the call.

| Route                                                           | RagQuery handler / run                                |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /v1/rag/collections`                                       | `listCollections`                                     |
| `GET /v1/rag/collections/:collection`                           | `getCollection` — settings, document and chunk counts |
| `GET /v1/rag/collections/:collection/documents?limit&cursor`    | `listDocuments` — ledger entries by document id       |
| `GET /v1/rag/collections/:collection/documents/:id?chunks=true` | `getDocument`, optionally with its chunks in order    |
| `POST /v1/rag/collections/:collection/search`                   | `search` (`Idempotency-Key` honoured)                 |
| `POST /v1/rag/collections/:collection/answer`                   | `answer` (`Idempotency-Key` honoured)                 |
| `POST /v1/rag/collections/:collection/documents`                | `rag-ingest` upsert run → 202 `{ runId }`, `Location` |
| `DELETE /v1/rag/collections/:collection/documents/:id?version`  | `rag-ingest` delete run → 202                         |
| `DELETE /v1/rag/collections/:collection`                        | `rag-ingest` drop run → 202                           |

`listDocuments` pages in document-id order: `limit` 1–200 (default 50), and `cursor` is a
`nextCursor` passed back exactly as returned (up to 2,048 characters).

### Search

`{ query, topK?, filter?, minScore?, includeVector?, ef?, probes?, rerank? }` returns:

```
{ collection, embeddingModel, reranked,
  hits: [{ id, score, documentId, chunkIndex, title?, text, metadata, vector?, rerank? }] }
```

| Option          | Default                      | Notes                                                                                                                                                                                      |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `topK`          | 5                            | ≤ 50                                                                                                                                                                                       |
| `filter`        | —                            | a Mastra metadata filter, see below                                                                                                                                                        |
| `minScore`      | —                            | applied after the query (passing it to PgVector would disable the HNSW index)                                                                                                              |
| `includeVector` | false                        |                                                                                                                                                                                            |
| `ef`            | Mastra's `max(topK, m·topK)` | HNSW search breadth: higher is more accurate, slower                                                                                                                                       |
| `probes`        | —                            | IVFFlat only (not offered for new collections)                                                                                                                                             |
| `rerank`        | off                          | `{ model?, topK?, candidates?, weights? { semantic, vector, position } }`: `topK` hits kept (default: the request's), from `candidates` rescored (default `min(20, 3 × kept)`, at most 20) |

**Filters** are Mastra's MongoDB-style metadata filters, checked against a whitelist before the
query; anything else is a 400 naming each problem.

- **Fields** are single metadata keys. Chunk metadata is flat, so there are no dot paths or nested
  fields (Mastra would compile those to SQL that loses or misreads conditions).
- **Values:** a bare value means equality, a bare array means `$in`, an object holds operators:
  `$eq $ne $gt $gte $lt $lte $in $nin $all $exists $size`, and `$not` over operators.
- **Between filters:** `$and`, `$or`, `$nor` (each a non-empty array of non-empty filters), `$not`
  (a non-empty filter).
- **Arrays:** equality on an array field compares the whole array, so match an element with `$in`
  (any of) or `$all` (all of). `$all` takes strings only: it matches string elements only.
- **Missing keys:** unlike MongoDB, `$ne`, `$nin`, `$not` and `$nor` leave out chunks that lack the
  key. `{ key: { $eq: null } }` or `{ key: { $exists: false } }` finds those.
- **Refused:** `$regex` and `$contains`, which compile to `~` and `ILIKE` scans; keys that name
  prototype machinery (`__proto__`, `constructor`, `prototype`).
- **Size:** at most 64 conditions, 1,000 values across all lists, and 8 levels of nesting.
- **Index use:** a filtered query scores every matching row exactly; the vector index is not used.
  Equality on a key listed in `index.metadataIndexes` uses its b-tree index. A search that runs past
  25 s (the store's statement timeout) fails with a 400: narrow the filter.

**Rerank.**

- Mastra's `rerankWithScorer`, scoring each candidate's relevance with one call to `rerankModel`
  (`chat-default`). The calls run concurrently, so candidates are capped at 20. Each reads at most
  4,000 characters of its candidate, as untrusted data, and has 60 s.
- The scorer takes the first number between 0 and 1 in the model's reply. A reply without one scores
  0, so one chatty reply does not fail the rerank; the candidate keeps its vector and position
  scores.
- `score` stays the vector similarity; `rerank.score` holds the reranked one, and hits come back in
  that order.
- The weights must sum to 1, within 1e-6; they are then snapped to exact millionths, because
  Mastra checks the sum in exact decimal arithmetic. The default is
  `{ semantic: 0.4, vector: 0.4, position: 0.2 }`.

**Limits.** A value above a limit (`topK` above 50, candidates above 20, `maxContextChars` above
12,000, `maxOutputTokens` above 2,048) is refused with a 400, never quietly lowered. Unknown request
fields are refused too.

### Answer

`{ question, …search options, model?, temperature?, maxOutputTokens?, maxContextChars?, instructions? }` returns:

```
{ collection, status, answer, model, truncated?,
  citations: [{ id: "S1", documentId, chunkIndex, title?, score }] }
```

`status` is `answered` or `insufficient_evidence`. `truncated: true` says the model ran out of
`maxOutputTokens` and the answer stops mid-way.

**How an answer is produced:**

1. Retrieve (and rerank, if asked).
2. Number the hits `S1…Sn` and cut them to the evidence budget: `maxContextChars` (12,000) less the
   question and the instructions, which the model reads too. A request that leaves less than 500
   characters of evidence is refused with a 400.
3. If nothing was retrieved, answer `insufficient_evidence` without calling a model.
4. Otherwise ask `answerModel` (`chat-default`) to answer only from the sources. The prompt tells
   the model that the sources are untrusted data, never instructions, and that it must cite claims
   as `[S1]`. A source cannot pose as another: marker-shaped text in a chunk or a title (`[S2]`,
   `【S2】`) is defused before the model reads it.

The defaults fit `chat-default`'s 8,192-token context: 12,000 characters of prompt, 1,024 tokens of
answer. Text in scripts that take more tokens per character (Devanagari takes two to three times
as many) needs a smaller `maxContextChars`.

**How the reply is checked:**

- Markers may group (`[S1, S3]`), range (`[S1-S3]`) or use CJK brackets (`【S1】`); they are
  rewritten as `[S1, S2, S3]`. Brackets inside code spans are left alone.
- Unknown citation ids are dropped.
- An answer left with no valid citation becomes `insufficient_evidence`, as does a reply that is the
  `INSUFFICIENT_EVIDENCE` sentinel, however it is cased.
- `instructions` adds guidance to the system prompt; it does not replace it.
- `maxOutputTokens` defaults to 1024, up to `limits.maxOutputTokens` (2,048). The answer is generated
  once, with no retry behind a waiting caller.

**Retrying.** With an `Idempotency-Key`, a retry gets the first request's outcome. After a 504 that
is the answer still being written: the retry waits for it. After a failure it is that failure, for
the hour Restate keeps outcomes, so retry a 5xx with a new key. The same holds for a search.
core-api never sends the key itself: Restate gets a hash of it bound to the request body, so a key
reused for a different request is a different call, never a stale answer.

### `RagQuery` config (`metadata.json`)

| Key                      | Default        | Meaning                                             |
| ------------------------ | -------------- | --------------------------------------------------- |
| `answerModel`            | `chat-default` | answers when a request names no model               |
| `rerankModel`            | `chat-default` | relevance scores when a rerank names no model       |
| `defaults.topK`          | `5`            | at most `limits.maxTopK` and `limits.maxCandidates` |
| `limits.maxTopK`         | `50`           |                                                     |
| `limits.maxCandidates`   | `20`           | rerank candidates, and hits a rerank keeps          |
| `limits.maxContextChars` | `12000`        | question, instructions and evidence of an answer    |
| `limits.maxOutputTokens` | `2048`         | the longest answer a request may ask for            |

Config rules a schema cannot state (such as `defaults.topK` within the limits) are checked at boot.

### Errors

| Situation                                                                                        | Code (HTTP)                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| a request `RagQuery` refuses: invalid body, filter, weights, limits                              | `INVALID_INPUT` (400)                                                           |
| a malformed path, query string, body or `Idempotency-Key`; a DELETE with a body                  | `INVALID_REQUEST` (400; 413 for a body over its limit, 414 for a path over 512) |
| unknown collection or document                                                                   | `NOT_FOUND` (404)                                                               |
| `rag-query` or `rag-ingest` not deployed                                                         | `NOT_DEPLOYED` (409)                                                            |
| the service failed, was canceled or killed, or Restate does not know `rag-query` or `rag-ingest` | `RESTATE_INGRESS_ERROR` (502)                                                   |
| Restate overloaded or unreachable                                                                | `RESTATE_UNAVAILABLE` (503)                                                     |
| no answer within the timeout                                                                     | `RESTATE_UNAVAILABLE` (504)                                                     |

Mutations go through `startRun`, so they answer with its codes. For example, an input that fails the
catalogued `rag-ingest` schema returns `INVALID_INPUT`. The rules a run checks when it starts
(reserved metadata keys, duplicate document ids, chunking sizes, template placeholders) are not the
route's: `POST …/documents` answers 202, and the run fails with a 400 (see Ingestion). core-api logs
every 5xx at warn, with its cause.

## Operations

- **Provisioning.**
  - `30-rag.sql` creates the `rag` database, the `vector` extension, the `vectors` schema, the
    registry and the ledger.
  - The units connect with `RAG_DATABASE_URL`. `pipeline deploy` sets it only for units whose
    closure includes `@ai-pipeline/rag`, together with `MASTRA_TELEMETRY_DISABLED=1`. It defaults to
    the compose database and can be pointed elsewhere with `UNIT_RAG_DATABASE_URL`.
  - Their role needs `CREATE` on schema `vectors`.
- **The two units upgrade separately.** Each reads a collection's stored settings leniently: a key
  the other, newer unit wrote is dropped on read rather than failing every query of the collection.
- **Embedding models are bound by name.** Never remap `embed-qwen3-0p6b`. For another model, add an
  alias and create a new collection. If the model behind an alias starts returning another dimension,
  every document write to that collection fails, saying so.
- **Tombstones accumulate.** Deleted documents keep a ledger row so late writes cannot resurrect
  them. To clear old ones:
  ```sql
  DELETE FROM rag_documents WHERE status = 'deleted' AND updated_at < now() - interval '30 days';
  ```
  Once a row is cleared, a write older than its delete could index the document again.
- **What the store refuses fails the document, once.** A value Postgres rejects as data (SQLSTATE
  class 22) fails the document with a 400, and an integrity violation (class 23) with a 409, instead
  of retrying a write that can never succeed. Connection and lock errors are retried as usual.
- **Dropping a collection while a run creates it.** The creating run notices, removes the table it
  made and fails with a 409, so no orphan table is left in `vectors`.
- **Step size.** A document is one step, and Restate aborts a step that runs past roughly 20 minutes
  (inactivity plus abort timeout). `maxChunksPerDocument` and `maxExtractChunks` keep a document
  well inside that.
- **Tracing.** Each run's spans, and LiteLLM's embedding and generation spans, share one trace (see
  the README's observability section).

## Not yet

- URL, blob storage, knowlg and file sources (PDF/DOCX parsing). Today text arrives inline or in
  the Kafka event.
- Answer streaming.
- Hybrid (BM25) search; GraphRAG; Mastra's `schema` extractor (a zod schema cannot arrive as JSON).
- Re-embedding a collection under a new model in place. The registry's per-incarnation `table_name`
  leaves room for a pointer flip.
- Auth and tenant scoping for `/v1/rag`. Like the rest of v1, there is none.
- More than one catalogued handler per unit.
