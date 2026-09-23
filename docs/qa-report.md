# QA report — end-to-end test of the pipeline

**Date:** 2026-09-23 · **Found on:** `content-authoring@0.1.0`, `content-enrichment@0.2.0`,
`summary@0.2.0`, `content-metadata@0.1.0`, `quiz-generate@0.1.0` · **Fixed in:**
`content-authoring@0.1.2`, `content-enrichment@0.2.2`, `summary@0.2.2`, `content-metadata@0.1.2`,
`quiz-generate@0.1.2` · **Stack:** `compose.yaml` + `compose.observability.yaml`, host Ollama
`qwen3.5:4b`.

Everything below was found while testing the pipeline as a whole: the control plane, the CLI, both
triggers, the contracts, and a new reference workflow built for the purpose
([example-workflow.md](example-workflow.md)).

Each entry says how it was established. **Reproduced** means it was demonstrated against the running
stack in this session, with the evidence quoted. **Code** means it was established by reading the
code, and the claim is stated so it can be checked without re-deriving it.

**Everything below has been fixed.** Where a fix was verified against the running stack rather than
only by a test, the evidence is quoted with it.

| #    | Defect                                                        | Fix                                                                           |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| P1-1 | Kafka consumer evicted, never rejoins; trigger reads `active` | librdkafka timeouts on the subscription — the consumer group stays `Stable`   |
| P1-2 | Failed model call logs the prompt and the gateway key         | an allow-list error serializer, with tests on the bytes written               |
| P1-3 | `withLock` deadlocks the pool against itself                  | the locked section runs on the locked connection; 32 concurrent, all 200      |
| P1-4 | Caller-supplied `pattern` can wedge the event loop            | `re2js` as Ajv's regex engine — 25 s → 1 ms                                   |
| P2-1 | `pipeline new --kafka` can break `deploy` for every unit      | trigger ids normalised, metadata validated before writing, discovery tolerant |
| P2-2 | `retire` leaks the image                                      | the image is reclaimed with the container                                     |
| P2-3 | `Idempotency-Key` not bound to the body                       | the run records an input digest; a mismatch is `409 IDEMPOTENCY_KEY_REUSED`   |
| P2-4 | A failed deploy leaves an orphan container silently           | the CLI says what it left and how to adopt or remove it                       |
| P2-5 | zod refinements vanish from the schema and the hash           | `contractSchemas` refuses a contract JSON Schema cannot express               |
| P2-6 | `pnpm check` replays a cached PASS after the SQL drifts       | the guards' files are turbo inputs — the same experiment now fails            |
| P2-7 | Neither replay nor e2e runs with `check`                      | `pnpm verify` runs all three                                                  |
| P3-1 | `src/testing/` ships though CLAUDE.md says it does not        | excluded in `.dockerignore`                                                   |
| P3-2 | A private service leaks its existence (upstream Restate)      | documented; the ingress is not published                                      |
| P3-3 | A misspelled query filter reads as "no filter"                | query schemas are strict                                                      |
| P3-4 | `pipeline runs` cannot page                                   | `--limit` and `--cursor`                                                      |
| P3-5 | Kafka offsets past 2^53 collide in the run id                 | the run id is derived from the header text, not the narrowed number           |
| P3-6 | The Restate version is pinned in two unlinked places          | a drift guard, in the repo's existing idiom                                   |
| P3-7 | One closed keep-alive socket fails a whole e2e suite          | the helper retries an idempotent request once                                 |

---

## 1. Applying these fixes to a running stack

Three different things had to be rolled out, and they are not the same operation:

| What changed                                              | How it takes effect                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| shared packages (`contracts`, `runtime`, `observability`) | bump each unit's `version`, then `pipeline deploy` it — the control plane refuses otherwise with `VERSION_ARTIFACT_CONFLICT` |
| core-api itself                                           | `docker compose up -d --build core-api`                                                                                      |
| Kafka subscription settings                               | a reconcile — which happens on any `pipeline deploy` of that unit, or on a trigger toggle                                    |

The third one is worth spelling out, because it was a bug in the first attempt at P1-1. A redeploy
was **not** enough on its own: `diffSubscriptions` matched a live subscription on source and sink
only, so the reconciler kept a subscription whose consumer options were stale and the new settings
reached newly created subscriptions and nothing else. The two consumer groups made it visible under
identical load — `content-authoring`, whose subscription had been recreated, read `Stable 1`, while
`content-enrichment`, redeployed but not recreated, read `Empty 0` and kept failing its Kafka e2e
tests.

`matches()` now compares the options too, so a settings change is rolled out by the same reconcile
that rolls out everything else. After it, both groups read `Stable 1 member`.

---

## 2. Suite results

| Command            | Before                                          | After                                    |
| ------------------ | ----------------------------------------------- | ---------------------------------------- |
| `pnpm check`       | pass — 297 unit tests                           | **pass — 327 unit tests**                |
| `pnpm test:replay` | pass — 11 always-replay tests                   | **pass — 11**                            |
| `pnpm test:e2e`    | **fail** — 16 passed, 4 failed, 1 suite errored | **pass — 20 passed, 5/5 suites** (471 s) |

Every e2e failure was the same defect. Four were the Kafka consumer (P1-1) and the fifth was a
closed keep-alive socket taking a suite with it (P3-7):

```
before                                                             after
× content-authoring  > Kafka trigger > starts a run …    (520 s)   ✓
× content-authoring  > Kafka trigger > fails malformed … (64 s)    ✓
× content-enrichment > Kafka trigger > starts one run …  (316 s)   ✓
× content-enrichment > Kafka trigger > fails malformed … (66 s)    ✓
FAIL versioning.test.ts — TypeError: fetch failed / UND_ERR_SOCKET ✓
```

The run in between is worth keeping, because it is what isolated the subscription-options gap:
18 passed / 2 failed, with both failures on `content-enrichment` — the one subscription that had
been redeployed but not recreated.

## 3. What was verified working

| Area                            | Evidence                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pipeline new`                  | scaffolded three units that built, linted and typechecked unmodified                                  |
| `pipeline deploy`               | built and registered 3 new units; dependency-order refusals behave as documented                      |
| REST trigger                    | `content-authoring` run completed in ~55 s — summary, 8 keywords, 4 concepts, 3 well-formed questions |
| Kafka trigger                   | DIKSHA record → `kf_…` run, trigger context carrying partition/offset, `["Hindi"]` → `hi`             |
| Adapter skip / fail semantics   | 4 records → 1 run, 2 silent skips, 1 terminal `[400]` with a readable message                         |
| `ctx.run` exactly-once          | 2 completed runs → exactly 2 `authoring pack ready` log lines, each with the run's `traceId`          |
| Private services                | `ContentMetadataService`, `QuizGenerateService`, `SummaryService` all refuse ingress: "not public"    |
| Contract validation             | unknown key, missing field, bad `status`, oversized `limit`, bad `cursor` — all refused with codes    |
| Idempotency (same body)         | second POST with the same key returns `PreviouslyAccepted` and the same `runId`                       |
| Catalogue                       | triggers, dependencies, versions, `contractHash` and schemas all correct for the new units            |
| `.default()` in an input schema | works end to end: optional in the catalogue schema, filled in by the handler's serde                  |

---

## 4. Bugs

### P1-1 — The Kafka consumer is evicted and never rejoins; the trigger still reports `active`

**Reproduced repeatedly, on two topics, with and without load.**

Records published to a subscribed topic stop being consumed. They accumulate indefinitely. The
control plane reports the trigger healthy the whole time:

```
$ curl -s localhost:3000/v1/workflows/content-authoring | jq '.triggers[1]'
{ "id": "diksha-content-published", "type": "kafka", "desiredEnabled": true,
  "observedStatus": "active", "subscriptionId": "sub_125nFwpxt91vPvCYMhiVBWF" }

$ kafka-consumer-groups.sh --describe --group wf.content-authoring.diksha-content-published
Consumer group '…' has no active members.
PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
0          4               7               3
1          2               3               1
2          6               7               1
```

**Root cause, from the broker's own log.** Restate's consumers are removed from their groups on
heartbeat expiration and never rejoin — both subscriptions, in the same second:

```
[GroupCoordinator id=1] Member restate-1c8b4288-… in group wf.content-authoring.diksha-content-published
    has failed, removing it from the group.
[GroupCoordinator id=1] Preparing to rebalance … (reason: removing member … on heartbeat expiration.)
[GroupCoordinator id=1] Group wf.content-authoring.diksha-content-published with generation 6 is now empty.
[GroupCoordinator id=1] Member restate-b0218fa3-… in group wf.content-enrichment.content-published
    has failed, removing it from the group.
```

Restate also logs `restate_node::failure_detector: Severe lag (5.6s) … indicates an overload or a
stall` around those windows, which is the likely reason the heartbeats are missed. But the stall is
only the trigger; **the defect is that nothing rejoins and nothing notices.**

**It is not load-related.** On a completely idle stack — no runs, no LLM traffic, records chosen to
be _skipped_ by the adapter so no work starts — 0 of 5 records published over 2.5 minutes were
consumed:

```
baseline=12  (records are Collections -> skipped, so no LLM load)
record 1 -> consumed=no  count=12
record 2 -> consumed=no  count=12   … 3, 4, 5 likewise
final lag: p0=3, p1=1, p2=1
```

**Recovery works — recreating the subscription drains the whole backlog at once**, which proves the
sink, the adapter and the committed offsets are all fine and it is purely the consumer:

```sh
curl -X PATCH …/triggers/diksha-content-published -d '{"enabled":false}'
curl -X PATCH …/triggers/diksha-content-published -d '{"enabled":true}'
# ContentAuthoringTrigger invocations: 4 → 9 (all five backlogged records processed immediately)
```

**Why it matters.** Kafka is the production trigger. This is unbounded, silent ingestion loss behind
a green status light, and it recovers only when a human notices runs have stopped and toggles the
trigger by hand. It is also why `pnpm test:e2e` cannot currently pass.

**Fixed — at the root, with Restate's own mechanism.** A subscription's `options` are passed
straight through to librdkafka ([Restate docs][kafka-docs]), so the eviction is prevented rather
than detected and repaired. `desiredSubscriptions` (`apps/core-api/src/domain/reconcile.ts`) now
sets, alongside the group id:

```
session.timeout.ms    120000   (librdkafka defaults to 45s — not enough for a stalled host)
heartbeat.interval.ms  10000   (comfortably under a third of the session timeout)
max.poll.interval.ms  600000   (headroom for a poll loop starved by the same stall)
```

The evidence that this is the right lever is the consumer group itself. Before, every reading said:

```
Consumer group '…' has no active members.
```

After, the same command reports the member staying joined:

```
GROUP                                          STATE    #MEMBERS
wf.content-authoring.diksha-content-published  Stable   1
```

and a published record is consumed in under three seconds.

An earlier attempt solved this the wrong way — a `kafkajs` dependency in core-api, a background
watchdog measuring consumer-group lag, a `stalled` wire status and a recreate path through the
reconciler. It worked, but it was a large amount of machinery for this repo to own in order to
paper over an upstream default. It was removed in favour of the three lines above.

**Still true, and worth knowing:** `observedStatus: active` means _Restate holds a subscription_,
which is all Restate can be asked. It is not proof that records are being consumed. If ingestion
ever stops again, the recovery is unchanged — toggle the trigger off and on, and the backlog drains
from the committed offsets.

[kafka-docs]: https://docs.restate.dev/services/invocation/kafka

---

### P1-2 — A failed model call logs the prompt and the gateway Authorization header

**Reproduced.** `packages/observability/src/logger.ts:10` registers `pino.stdSerializers.err` for
both `err` and `error`. That serializer re-emits every enumerable own property of the error. An AI
SDK `APICallError` carries `requestBodyValues` (the entire prompt — i.e. the learner-facing content)
and `responseHeaders` (which can carry `authorization`). The `redact` list — `input`, `text`,
`apiKey`, `headers.authorization` — matches none of those paths:

```
contains prompt text?  True
contains bearer key?   True
serialized error keys: ['type','message','stack','name','url','requestBodyValues','responseHeaders']
```

Every retry of a failing LLM step writes one of these lines, and `retry.llm` is uncapped, so a
gateway outage produces them indefinitely.

**Suggested fix.** Serialize `name`/`message`/`code`/`status` only, or add
`error.requestBodyValues`, `error.responseHeaders`, `err.requestBodyValues`, `err.responseHeaders`
to `redact`. A unit test on `createLogger` would have caught it; there is none.

---

### P1-3 — `withLock` holds a pooled connection while its body needs more from the same pool

**Reproduced against the live API**, with the exact stack traces from core-api.

`apps/core-api/src/store/db.ts:45` checks a client out of the pool, holds it for the whole locked
section, and the section then does all its work through _the same_ 8-connection pool
(`max: 8`, `connectionTimeoutMillis: 5_000`, `db.ts:17`). Past a threshold every request waits 5 s
and some fail outright — with entirely distinct lock keys, so this is not lock contention:

```
concurrency=2  : 2 × 200 (0.13 s)
concurrency=8  : 8 × 200 (0.06 s)
concurrency=10 : 7 × 200 (5.4 s)  3 × 500 (5.1 s)
concurrency=12 : 7 × 200 (5.2 s)  5 × 500 (5.1 s)
```

```
"message":"timeout exceeded when trying to connect"
  at async withLock (dist/store/db.js:34)            ← the lock's own connect()
  at async setTriggerEnabled (dist/domain/triggers.js:75)

"message":"timeout exceeded when trying to connect"
  at async Object.setObserved (dist/store/triggers.js:30)   ← work inside the lock
  at async reconcile (dist/domain/triggers.js:63)
  at async withLock (dist/store/db.js:37)
```

The second trace is the mechanism: a request holding the lock connection cannot get a second one to
do its work.

`POST /v1/deployments` degrades sooner because it nests — `withLock('register:<name>')`
(`domain/registration.ts:38`) → `reconcileTriggers` → `withLock('reconcile:<name>')`
(`domain/triggers.ts:46`) → plus a `transaction()` (`registration.ts:163`): three of eight
connections for one in-flight deploy.

**Chains with P2-4.** The failure surfaces as `500 INTERNAL`, which is not in
`PRE_REGISTRATION_CODES`, so `apps/cli/src/commands/deploy.ts:136` neither retries it nor removes
the container it started — parallel deploys leave orphans.

**Suggested fix.** Run the locked section _on the locked client_ (pass it down as the `Queryable`),
or take advisory locks from a small dedicated pool outside the request pool.

---

### P1-4 — Caller-supplied `pattern` is compiled and matched on the API event loop

**Code** (`apps/core-api/src/json-schema.ts:5`). Ajv is built with `strict: true` but no
`code.regExp` override, so `pattern` compiles to a native `RegExp` with unbounded backtracking.
Caller-supplied schemas reach it twice:

- `POST /v1/deployments` compiles all three submitted schemas and validates `metadata.config`
  against the submitted config schema — one request supplies both the pattern and the subject;
- `POST /v1/workflows/:name/runs` then validates every caller's input against the catalogued schema,
  so one poisoned registration affects every later run start.

Node is single-threaded: a catastrophic backtrack blocks Fastify entirely, `/health/ready` included.
`requestTimeout: 30_000` does not help because nothing is waiting on I/O.

**Mitigating:** there is no auth on this API, but every port binds to `127.0.0.1` behind a Host
allow-list, so the exposure is local by design.

**Suggested fix.** Give Ajv a safe engine (`code: { regExp: … }`, e.g. `re2`), or reject `pattern` in
`checkSchemas` — nothing in the repo's own contracts uses it.

---

### P2-1 — `pipeline new --kafka <topic>` can write a `metadata.json` that breaks `deploy` for _every_ unit

**Reproduced (derivation) + code.** The scaffolder derives the trigger id as
`topic.replace(/[._]/g, '-')` (`apps/cli/src/commands/scaffold.ts:148`), but `metadata.json` requires
a lower-case kebab identifier. Legal Kafka topic names that produce an invalid id:

```
Orders.Placed     -> Orders-Placed    ✗ upper case
orders..placed    -> orders--placed   ✗ adjacent separators
orders_placed_    -> orders-placed-   ✗ trailing separator
```

The escalation is the real problem: `findUnit` calls `discoverUnits`, which **parses every unit's
`metadata.json` eagerly** (`apps/cli/src/units.ts:20-31`). One unit scaffolded from a mixed-case
topic therefore makes `pnpm pipeline deploy <any other unit>` throw until someone edits the file by
hand — directly contradicting "adding one does not disturb the others".

**Suggested fix.** Normalise in the scaffolder (lower-case, collapse runs, trim separators) and
validate the generated metadata before writing it. Make `findUnit` tolerate a unit it cannot parse
unless that unit is the one being deployed.

---

### P2-2 — `retire` removes the container but never the image

**Reproduced.** `apps/cli/src/commands/deployments.ts:34` removes the container and nothing else.
Every immutable deploy builds `ai-pipeline/<name>:<version>-<digest12>`, and they accumulate for
ever. On this machine after a few days of development:

```
59 × ai-pipeline/* images (~435 MB each); 35 of them the versioned-sleeper e2e fixture
docker system df: Images 97, 74.19 GB, 60.64 GB (81%) reclaimable
```

**Suggested fix.** Remove the image alongside the container when no other live deployment shares the
artifact — `retireDeployment` already computes exactly that condition (`shared`).

---

### P2-3 — `Idempotency-Key` is not bound to the request body

**Reproduced.** The run id is derived from the workflow name and the key only (`apiRunId`,
`domain/runs.ts:75`). Re-POSTing the same key with a completely different input returns `202
PreviouslyAccepted` for the original run and silently discards the new payload:

```
POST …/runs  idempotency-key: qa-demo-1  {"contentId":"COMPLETELY-DIFFERENT", …}
→ 202 {"runId":"api_02d6…","status":"PreviouslyAccepted"}
   stored contentId = do_31309317310697472011526     ← still the original
```

A client that keys on something coarser than the request (a content id, a user id) is told 202 for
work that will never happen.

**Suggested fix.** Fold a hash of the canonical input into the run id, or store the request digest
with the run and answer `409` when a reused key carries a different body.

---

### P2-4 — A deploy that fails without a pre-registration code leaves an orphan container

**Code** (`apps/cli/src/commands/deploy.ts:136`). The container this deploy started is removed only
when the failure is an `ApiError` whose code is in `PRE_REGISTRATION_CODES`. A transport failure, or
any `500 INTERNAL` (see P1-3), matches neither, so the container keeps running unregistered —
contradicting the guarantee the step 1–2 / 3–4 split is designed to give.

---

### P2-5 — zod refinements vanish from the catalogue schema _and_ from `contractHash`

**Reproduced.** `contractSchemas` uses `z.toJSONSchema` (`packages/contracts/src/schemas.ts:14`),
which silently drops `.refine()`/`.superRefine()`:

```js
z.strictObject({ a: z.string() }).refine((v) => v.a.startsWith('do_'));
// → {"type":"object","properties":{"a":{"type":"string"}},"required":["a"],…}   refinement gone
```

Two consequences. The API accepts input with `202` that the handler's own Standard Schema serde then
rejects, so the caller is told the run started and finds it failed. And because `contractHash` is
computed over the JSON Schema, two contracts differing only in a refinement hash identically, so
`VERSION_CONTRACT_CONFLICT` cannot fire.

Nothing shipped uses `.refine()` yet, which is why it has not bitten. CLAUDE.md tells the next
developer to express everything in zod, so it will.

**Suggested fix.** Fail the deploy when a contract carries a refinement the JSON Schema cannot
express, or fold refinements into `contractHash` separately.

---

### P2-6 — `pnpm check` replays a cached PASS after the provisioning SQL drifts

**Reproduced.** `apps/core-api/src/store/schema.test.ts` exists to fail the build when a repository
queries a table the provisioning SQL does not create. But `infra/postgres/init/**` is not in
`//#test:unit`'s `inputs` (`turbo.json:60`), which lists only
`{packages,services,workflows,apps,tests/fixtures}/*/src/**`, `vitest.config.ts` and
`pnpm-workspace.yaml`.

From a green, warm-cache baseline I deleted the whole `CREATE TABLE workflow_dependencies` block —
exactly the drift the guard is for — and ran `pnpm check`:

```
//:test:unit: cache hit, replaying logs e7fea7aa3b5bb717
//:test:unit: Tests  297 passed (297)
 Tasks:    55 successful, 55 total
Checked 341 files in 19 packages, no issues found
```

Fully green; the guard never ran. The same applies to
`apps/core-api/src/routes/collection.test.ts`, which reads
`manifests/ai-pipeline.postman_collection.json` — also not an input.

(The guard checks _table_ names, not columns — that is what it documents, and it holds when it runs.)

**Suggested fix.** Add `infra/postgres/init/**` and `manifests/**` to that task's `inputs`.

---

### P2-7 — `pnpm check` runs neither the replay nor the e2e suite, and nothing else does either

**Code.** `package.json:14`. The CI pipeline was dropped (`42de857 chore: drop the CI pipeline for
now`), so the two suites that exercise durability and the real stack run only when someone remembers.
Both found real failures in this session; the e2e one has been failing silently for some time.

---

### P3-1 — CLAUDE.md says `src/testing/` does not ship; it does

`apps/cli/src/artifact.ts:9` excludes `**/testing/**` from the **artifact digest**, but
`tsconfig.build.json` excludes only `src/**/*.test.ts` and `.dockerignore` excludes neither. A unit
with a `src/testing/` directory would compile it into `dist/` and ship it — and two different images
could then share one digest. Only `apps/core-api` has such a directory today, and apps are not
deployed by `pipeline deploy`, so nothing is currently affected.

### P3-2 — A private service leaks its existence through an unknown handler

**Reproduced** (Restate ingress behaviour, not this repo's code):

```
SummaryService/summarize      → 400 "the invoked service is not public"                       ✔
SummaryService/nosuchhandler  → 404 "the service 'SummaryService' exists, but the handler …"
TotallyUnknownService/x       → 404 "service 'TotallyUnknownService' not found"
```

Handler lookup runs before the private check, so an unauthenticated ingress caller can enumerate
which private services exist. Contained today because the ingress is not published to the host.

### P3-3 — Unknown query parameters are silently ignored

**Reproduced.** `GET /v1/runs?workfloww=nonsense&limit=2` returns an _unfiltered_ page instead of a
refusal, because the query schemas are not strict (`packages/api-contract/src/runs.ts:41`). A typo in
a filter reads as "no filter". `status`, `limit` and `cursor` are all validated properly.

### P3-4 — `pipeline runs` cannot page

`listRuns` (`apps/cli/src/commands/runs.ts:23`) sends only `workflow` and `status`. The API defaults
to `limit=50` and returns a `nextCursor` that the CLI prints and offers no way to use, so the CLI
quietly shows the first page only.

### P3-5 — Kafka offsets above 2^53 collide in the run id

`integerHeader` narrows through `Number()` (`packages/runtime/src/kafka-trigger.ts:136`), so offsets
`9007199254740992` and `…93` both become `…92` and derive the same run id — Restate would dedupe the
second record as a replay of the first. Unreachable in practice, but it is a silent-loss failure mode
rather than an error.

### P3-6 — The Restate version is pinned in two unlinked places

`compose.yaml` pins `restate:1.7.10`; the replay tests pin `new RestateContainer('1.7.10')`. Nothing
fails if they drift, unlike the SQL and Postman guards the repo already has (which have their own
problem — P2-6).

### P3-7 — The e2e HTTP helper has no retry, so an idle keep-alive socket fails a whole suite

**Reproduced.** `versioning.test.ts` errored at the suite level:

```
TypeError: fetch failed   ❯ api tests/e2e/support.ts:23   ❯ versioning.test.ts:31
Caused by: SocketError: other side closed  { code: 'UND_ERR_SOCKET', remotePort: 3000 }
```

`support.ts:23` uses bare `fetch` with the default agent and no retry, and core-api sets
`requestTimeout` but not `keepAliveTimeout` (`apps/core-api/src/app.ts:34`). After the long idle gaps
this suite has between deploys, the server closes a keep-alive socket that undici then reuses. One
lost socket fails the suite rather than one request.

**Suggested fix.** Retry idempotent requests once on `UND_ERR_SOCKET` in `support.ts`, or send
`connection: close` from the helper.

---

## 5. Test-suite gaps

Not defects in the product — the reason several of the defects above survived.

| Gap                                                                                                     | Where                                           |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `paused` / `resume` has no test at any level, although the README builds an operations story on it      | `domain/runs.ts:171`, `tests/e2e`               |
| No test ever produces a **failed** run, so the failed-run view and `status=failed` are unverified       | `apps/core-api/src/views.ts`                    |
| `cancel` and `kill` are never exercised against a real in-flight run                                    | `tests/e2e/triggers.test.ts`                    |
| Kafka **redelivery / duplicate offset** dedup — the entire point of `kafkaRunId` — is untested          | `tests/e2e/content-enrichment.test.ts`          |
| No test executes the catalogue SQL; `store/` is covered only by an in-memory fake                       | `apps/core-api/src/store/*`                     |
| `isRetryableModelError` — which decides retry-forever vs fail-permanently — has no test                 | `packages/ai/src/errors.ts`                     |
| Pagination is tested only against synthetic rows; no test follows a `nextCursor`                        | `apps/core-api/src/restate/invocations.test.ts` |
| Nothing builds, lints or deploys a **scaffolded** unit — the scaffolder is tested by reading its output | `apps/cli/src/commands/scaffold.test.ts`        |
| The logger's redaction is untested (P1-2)                                                               | `packages/observability`                        |

The reference workflow added in this session closes some of this for its own unit: every adapter
path (map, skip, terminal failure) is unit-tested, the replay test asserts the replay counter _and_
the exactly-once counters for all four journaled steps, and the e2e suite covers both triggers, the
refusals, and the `.default()` behaviour.

---

## 6. Checked and not a defect

- **`.default()` in a workflow input schema works end to end.** The catalogue's _input_ schema marks
  the field optional and the handler's Standard Schema serde fills it in: `language` was absent from
  the REST request and `en` in the output. Now pinned by an e2e assertion.
- **Private services are genuinely not invocable** through the ingress — all three refused.
- **`INVALID_CURSOR`, `INVALID_INPUT`, oversized `limit`, bad `status`** all refuse correctly with
  the documented envelope.
- **Terminal Kafka failures do not block the partition.** The consumer stall (P1-1) happens with and
  without a malformed record in the batch, so the two are unrelated.
- **`schema.test.ts` checks tables, not columns** — which is what it documents. The problem is that
  it does not re-run (P2-6), not what it asserts.
