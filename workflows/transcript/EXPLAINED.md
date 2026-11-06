# Transcript Workflow — How It Starts, Works, and Ends

Restate workflow that generates a source-language transcript for a Content's video
artifact, then translates it into the configured target languages (`ar`, `pt`, `fr`), writing
each as its own `Transcript` `EnrichmentObject` on the parent Content.

---

## 1. What triggers it

Two triggers are registered (`workflows/transcript/metadata.json`):

- `api` — a plain REST trigger, useful for manual runs (`pnpm pipeline start transcript --input '<json>'`).
- `content-published` — a Kafka trigger on topic `content.published` (environment-neutral in the
  artifact; core-api prepends an environment-specific prefix at subscribe time via
  `KAFKA_TOPIC_PREFIX`).

The Kafka topic carries a generic **content-published event**, emitted by knowlg-publish exactly
once on every Content/Collection/Question/QuestionSet publish — always, whether or not any
enrichment was requested, wrapped in the platform's standard `BE_JOB_REQUEST` envelope:

```json
{
  "eid": "BE_JOB_REQUEST",
  "ets": 1757930000000,
  "mid": "LP.1757930000000.a1b2c3",
  "actor": { "id": "knowlg-publish", "type": "System" },
  "edata": {
    "action": "content-published",
    "identifier": "do_214666147480223744136",
    "objectType": "Content",
    "mimeType": "video/mp4",
    "channel": "0146092176054435840",
    "status": "Live",
    "artifactHash": "abc123",
    "prevArtifactHash": "abc122",
    "enrichmentTypes": ["Transcript"]
  }
}
```

knowlg-publish applies no eligibility gate at all — `edata.enrichmentTypes` is just the node's own
array, verbatim, `[]` when nothing was requested. `src/adapters.ts`'s `contentPublishedEvent`
adapter is the only place on the Kafka path that decides whether a given event is worth reacting
to; `run()` itself re-applies the same check for the REST trigger, which has no adapter of its own.

`contentPublishedEvent` is `(event, log) => Input | null`:

- First checks eligibility (`enrichmentTypes` contains `"Transcript"`, `objectType` is `"Content"`,
  `mimeType` is a supported video type) against a loose, mostly-optional shape — deliberately
  _before_ requiring the full event shape below, so a Collection/Question publish (which has no
  `mimeType` at all) is skipped as "not mine", not failed as "malformed". Each skip is logged at
  `debug` (this topic carries every publish of every object type, so skips are the overwhelming
  majority of this adapter's calls); an accepted event logs at `info`.
- Only once an event is known relevant does it get strict-parsed against the full envelope shape
  and mapped to `TranscriptInput`: `{identifier, objectType, mimeType, channel}`. A malformed event
  that still claims eligibility fails the record terminally here — it never blocks the partition.

## 2. What starts running

Restate starts a `Transcript` workflow execution per trigger: a Kafka record gets a run id
derived from its own coordinates (cluster/topic/partition/offset/timestamp — see `kafkaRunId`),
not from the Content's identifier, so two publishes of the _same_ Content still land as two
independent workflow executions. A REST start gets a random run id unless the caller passes an
`Idempotency-Key`.

`run()` (the workflow handler) does no work itself: it immediately delegates to a `TranscriptObject`
Virtual Object, keyed by `identifier`, via `ctx.client(transcriptObjectApi, identifier).process(input)`.
Virtual Object handlers are exclusive by default, so Restate serializes every call for the same
key — a re-publish arriving while the first run is still in Whisper queues behind it instead of
running concurrently. This is what actually prevents two runs for one Content from racing each
other through knowlg; the workflow layer above exists only to give every Kafka delivery its own
durable, inspectable run id.

`process()` in `src/workflow.ts` is invoked with the mapped input. Every side-effecting step is
wrapped in `ctx.run(name, fn, retryPolicy)` — Restate persists each step's result once it
succeeds, so a crash/restart resumes from the last completed step instead of redoing everything.

### Step 1 — create the source Transcript node

```
ctx.run('knowlg.create-source', () => createEnrichmentObject(..., { sourceLanguage: true }))
```

Calls knowlg's `POST /object/enrichment/v4/create`. The platform's own `uniqueOn` matching
(on the registered `Transcript` category definition) makes this idempotent: if a source
Transcript already exists for this parent, the call returns that existing node instead of
creating a duplicate — this is what makes retried/redelivered Kafka records safe.

Three paths from here (`createOrRefreshNode`):

- **Already `Live`, same artifact** (an earlier run already finished this Content, and the
  event's `artifactHash` — when present — still matches what was stamped on the node): skip
  straight to re-downloading the previously-uploaded `transcript.json` from blob storage
  (`blob.download-source`) instead of re-transcribing. Needed because the platform's edit-lock
  rule rejects any `update()` against an already-`Live` node — trying to redo the work would
  just fail.
- **Already `Live`, different artifact** (the Content was re-published with a replaced video):
  the stale node is retired (`reject` → `Retired`, which the platform's `searchSiblings` then
  ignores) and a fresh node is created in its place, so the rest of this step proceeds down the
  "not yet Live" path below against the new node.
- **Not yet Live** (fresh, or was left mid-flight): proceed to generate it.

### Step 2 — read the Content, transcribe, upload, approve (fresh path only)

1. `knowlg.read-content` — `GET /content/v3/read/:id` for the video's `artifactUrl`. The event
   itself never carries this (see step 1's design note) — the workflow fetches it itself once
   it has the identifier.
2. `ctx.client(whisperApi).transcribe({ artifactUrl })` — a Restate service call to Whisper's
   `WhisperService`, journaled by the SDK like any other durable call (not a plain HTTP request
   with a custom client-side timeout). **No `language` parameter is passed** — the source language
   is auto-detected by Whisper, never assumed or hardcoded. Returns
   `{language, languageProbability, duration, segments: [{id, start, end, text}, ...]}`.
3. `blob.upload-source` — uploads `transcript.json` (raw segments) and `captions.vtt` (WebVTT)
   to `content/<parentId>/transcripts/<languageCode>/` in blob storage. From here on the retry
   profile for knowlg/blob steps is uncapped (`retry.httpResumable`): an outage now would
   otherwise discard the already-completed Whisper transcription.
4. `knowlg.update-source` — `PATCH /object/enrichment/v4/update/:id`, writing back
   `languageCode`, `artifactUrl`, `captionsUrl`, `autoApproved: true`, `status: "Processing"`.
5. `knowlg.approve-source` — `POST /object/enrichment/v4/approve/:id` with `status: "Live"`.
   This phase's `approve()` is a status-only write (no Kafka event emitted yet — deliberately
   deferred to a later phase).

### Step 3 — translate into each configured target language

`config.targetLanguages` (`["ar", "pt", "fr"]`, minus whichever one matches the detected
source language) are processed **sequentially**, not in parallel — each call is a
multi-step async chain (`buildTranslation`), not a single durable value, and Restate's
`RestatePromise.all` only combines genuine single-step `ctx.run`/`ctx.client` results. Running
them one at a time also means one language's failure doesn't corrupt another's already-written
state.

For each target language, `buildTranslation` runs the same idempotent-create → generate →
upload → update → approve shape as the source:

1. `knowlg.create-<lang>` — create the target-language Transcript sibling
   (`sourceLanguage` omitted, `languageCode: <lang>`). Same `uniqueOn` idempotency: if this
   sibling is already `Live` from an earlier run, return it immediately, skip translating again.
2. **Translate** (`src/translate.ts`): segments are split into overlapping batches
   (`translationBatchSize: 80`, `translationBatchOverlap: 2` — each batch after the first
   repeats the previous batch's last 2 segments as leading context only, never re-emitted in
   the output). Each batch is translated via `translateChunk`, which prompts the configured LLM
   (`translationModel`, via LiteLLM) for a strict, schema-enforced JSON object keyed by segment
   id (not an array) — a truncated or incomplete response is retried with a doubled token budget
   up to 3 times, then the chunk is split in half and each half recurses; a single segment that
   still can't complete raises a `TerminalError`.
3. `blob.upload-<lang>` — same upload shape as the source, under
   `content/<parentId>/transcripts/<lang>/`. Uncapped retry from here on too, for the same reason
   as the source path (protects the already-completed LLM translation).
4. `knowlg.update-<lang>` then `knowlg.approve-<lang>` — same as the source.

### What comes back

```ts
{
  parentId: string,
  source: { identifier, languageCode, status },
  translations: [{ identifier, languageCode, status }, ...],
}
```

## 3. Timeouts

The LLM call's timeout is 180s (`LLM_TIMEOUT_MS` in `packages/ai/src/generate.ts`, matching
`infra/litellm/config.yaml`'s own `request_timeout: 180`), not longer — a slow local CPU model can
still exceed this on a large batch; a real hosted model should not.

## 4. How to test manually (docker-compose)

Prerequisites: a `kubectl -n sunbird port-forward svc/knowlg-service 9000:9000` running on the
host (real dev-cluster data — a real video, real Content, real EnrichmentObject category
registered as `Transcript`), with `UNIT_KNOWLG_BASE_URL` in `.env` pointed at it
(see `.env.example`).

```bash
cd ai-pipeline
docker compose up -d          # postgres, kafka, restate, litellm, otel, core-api, azurite
pnpm pipeline deploy transcript
pnpm pipeline start transcript --input '{"identifier":"do_214666147480223744136","objectType":"Content","mimeType":"video/mp4","channel":"0146092176054435840"}'
pnpm pipeline runs transcript          # list recent runs / statuses
pnpm pipeline run transcript <runId>   # poll a specific run
```

`whisper` (Python, no `package.json`) isn't part of this CLI's deploy flow yet and has no compose
service either — it needs to be built and run against the same `ai-pipeline` Docker network
separately.

To trigger via Kafka instead of the REST API, produce a raw content-published event (matching
the JSON shape in section 1) onto `content.published`.

Verify results against the real cluster:

```bash
curl -s -X POST http://localhost:9000/object/enrichment/v4/list \
  -H 'Content-Type: application/json' \
  -d '{"request":{"filters":{"parentId":"do_214666147480223744136"}}}'
```

Tear down once satisfied: `docker compose down`.
