# Transcript Workflow — How It Starts, Works, and Ends

Restate workflow that generates a source-language transcript for a Content's video/audio
artifact, then translates it into the configured target languages (`ar`, `pt`, `fr`), writing
each as its own `Transcript` `EnrichmentObject` on the parent Content.

Branch: `feat/transcript-workflow` (ai-pipeline repo). Status: source transcript proven
end-to-end against the real dev cluster; translation blocked only by local CPU-Ollama speed,
not a code defect (see "Known limitation" below).

---

## 1. What triggers it

Two triggers are registered (`workflows/transcript/metadata.json`):

- `api` — a plain REST trigger, useful for manual runs (`pnpm pipeline run transcript <input>`).
- `content-published` — a Kafka trigger on topic `dev.content.published`.

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
adapter is the only place that decides whether a given event is worth reacting to (does the array
contain `"Transcript"`, is it a Content, is the mimeType actually a video) — this producer never
decides that on any consumer's behalf.

`contentPublishedEvent` is a pure function: `(event) => Input | null`.

- Returns `null` (silently skips the record, no run started) for any event whose
  `edata.enrichmentTypes` doesn't contain `"Transcript"`, whose `edata.objectType` isn't
  `"Content"`, or whose `edata.mimeType` isn't video — this is how the same topic can carry
  unrelated publish events without this workflow reacting to them.
- Throws (fails the record terminally) if the event doesn't even match the expected envelope —
  a malformed event never blocks the rest of the partition.
- Maps a matching event down to the workflow's actual input, `TranscriptInput`:
  `{identifier, objectType, mimeType, channel}`.

## 2. What starts running

Restate starts one workflow execution keyed by the Content's `identifier`, invoking `run()`
in `src/workflow.ts`. Every side-effecting step is wrapped in `ctx.run(name, fn, retryPolicy)`
— Restate persists each step's result once it succeeds, so a crash/restart resumes from the
last completed step instead of redoing everything.

### Step 1 — create the source Transcript node

```
ctx.run('knowlg.create-source', () => createEnrichmentObject(..., { sourceLanguage: true }))
```

Calls knowlg's `POST /object/enrichment/v4/create`. The platform's own `uniqueOn` matching
(on the registered `Transcript` category definition) makes this idempotent: if a source
Transcript already exists for this parent, the call returns that existing node instead of
creating a duplicate — this is what makes retried/redelivered Kafka records safe.

Two paths from here:

- **Already `Live`** (an earlier run already finished this Content): skip straight to
  re-downloading the previously-uploaded `transcript.json` from blob storage
  (`blob.download-source`) instead of re-transcribing. Needed because the platform's edit-lock
  rule rejects any `update()` against an already-`Live` node — trying to redo the work would
  just fail.
- **Not yet Live** (fresh, or was left mid-flight): proceed to generate it.

### Step 2 — read the Content, transcribe, upload, approve (fresh path only)

1. `knowlg.read-content` — `GET /content/v3/read/:id` for the video's `artifactUrl`. The event
   itself never carries this (see step 1's design note) — the workflow fetches it itself once
   it has the identifier.
2. `whisper.transcribe` — `POST /transcribe?url=<artifactUrl>&fmt=json` against the Whisper
   service. **No `language` parameter is passed** — the source language is auto-detected by
   Whisper, never assumed or hardcoded. Uses a custom `undici.Agent` with a 900s
   headers/body timeout (Node's global `fetch` caps non-streaming calls at 5 minutes by
   default, which a full-length transcription blows through — this was a real bug, now fixed).
   Returns `{language, languageProbability, duration, segments: [{id, start, end, text}, ...]}`.
3. `blob.upload-source` — uploads `transcript.json` (raw segments) and `captions.vtt` (WebVTT)
   to `content/<parentId>/transcripts/<languageCode>/` in blob storage.
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
   the output). Each batch is one `ctx.run` step: prompts the configured LLM
   (`translationModel`, via LiteLLM) for a strict JSON array `[{id, text}, ...]`, parses and
   validates it, and raises a `TerminalError` on anything malformed or missing an expected id
   (never returns a silently-partial or misaligned translation).
3. `blob.upload-<lang>` — same upload shape as the source, under
   `content/<parentId>/transcripts/<lang>/`.
4. `knowlg.update-<lang>` then `knowlg.approve-<lang>` — same as the source.

### What comes back

```ts
{
  parentId: string,
  source: { identifier, languageCode, status },
  translations: [{ identifier, languageCode, status }, ...],
}
```

## 3. Known limitation (current local testing only)

Every translation attempt so far has timed out at the LLM call, purely because local testing
uses a CPU-based Ollama model — too slow for an 80-segment batch. This is **not a code
defect**: LiteLLM's own `request_timeout` and this workflow's client-side timeout are both
already generous (600s), and the underlying `undici` headers-timeout ceiling was already fixed
for Whisper the same way. Production will call a real hosted API key, which will be fast
enough — per explicit instruction, timeouts are not to be raised further to chase this.

## 4. How to test manually (docker-compose)

Prerequisites: `kubectl --kubeconfig=/Users/chethan/Downloads/dev.yaml -n sunbird port-forward
svc/knowlg-service 9000:9000` running on the host (real dev-cluster data — a real video, real
Content, real EnrichmentObject category registered as `Transcript`).

```bash
cd ai-pipeline
docker-compose up -d          # postgres, kafka, restate, litellm, otel, core-api, azurite, whisper
pnpm pipeline deploy transcript
pnpm pipeline run transcript '{"identifier":"do_214666147480223744136","objectType":"Content","mimeType":"video/mp4","channel":"0146092176054435840"}'
pnpm pipeline runs transcript                 # list recent runs / statuses
pnpm pipeline run transcript <invocation-id>  # poll a specific run
```

To trigger via Kafka instead of the REST API, produce a raw content-published event (matching
the JSON shape in section 1) onto `dev.content.published`.

Verify results against the real cluster:

```bash
curl -s -X POST http://localhost:9000/object/enrichment/v4/list \
  -H 'Content-Type: application/json' \
  -d '{"request":{"filters":{"parentId":"do_214666147480223744136"}}}'
```

Tear down once satisfied: `docker-compose down`.
