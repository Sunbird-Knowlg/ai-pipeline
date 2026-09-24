# Decisions

These are settled. Reopen one only with new evidence. [plan.md](plan.md) holds the design; this file records what the design settled and what building it taught us.

## Architecture (from the plan, revision 2)

- **The framework does not reimplement Restate.**
  - Restate is the durable runtime and the run store (introspection SQL, workflow state, ingress output).
  - Postgres holds only the catalogue (the control plane): definitions, deployments, dependencies, triggers.
  - There is no run table.
- **Building blocks.**
  - _Steps_ are plain in-handler functions and are not catalogued.
  - _Services_ get their own Restate invocation; `SummaryService` is private.
  - _Workflows_ have unique run IDs.
- **One contract source.**
  - zod plus `restate.iface` live in `packages/contracts`.
  - The deploy CLI generates the catalogue's draft-07 JSON Schemas from them. The core API validates REST input with Ajv against those schemas.
  - `metadata.json` is operational metadata only.
- **Immutable deployments.**
  - Each artifact is registered at its own endpoint (`<name>-<digest12>:9080`).
  - In-flight invocations stay pinned to their deployment.
  - A deployment is retired only once drained.
  - `--dev` re-uses `<name>-dev` with `force: true`. That is for local work only; it can break in-flight journals.
- **Control plane, not runtime.**
  - Runtimes only serve handlers.
  - `pipeline deploy` builds and starts the container, then calls `POST /v1/deployments`. Core-api then registers the deployment with Restate, updates the catalogue and reconciles Kafka subscriptions.
- **Triggers.**
  - REST goes only through core-api (`@restatedev/restate-sdk-clients`, `workflowSubmit`). The Restate ingress (8080) is not published.
  - Kafka uses Restate-native subscriptions into a thin `<Workflow>Trigger` service. That service adapts the record, derives an opaque run ID and calls `ctx.genericSend` on the workflow.
- **LLM calls.**
  - The AI SDK `generateText` runs through LiteLLM (`@ai-sdk/openai-compatible`) inside `ctx.run`, with `maxRetries: 0` and LiteLLM `num_retries: 0`, so Restate owns retries.
  - Mastra is deferred to v2 agent/RAG work, where it adds more than one model call.
- **No auth in v1.**
  - Every port is bound to `127.0.0.1`.
  - A Host-header allow-list (`ALLOWED_HOSTS`) is the only DNS-rebinding guard.

## Learned while building

- **One handler per Kafka trigger** (`on<TriggerId>`).
  - The documented subscription headers are `restate.subscription.id`, `kafka.partition`, `kafka.offset` and `kafka.timestamp`. None of them names the topic.
  - So a single `onEvent` handler could not tell its triggers apart. Each handler knows its cluster, topic and trigger ID from `metadata.json`.
- **Kafka run ID** is `kf_` + sha256(`kafka:<cluster>:<triggerId>:<topic>:<partition>:<offset>:<timestamp>`)[0..32].
  - The record timestamp keeps a recreated topic (offsets restart at 0) from colliding with runs still retained for 7 days. A redelivered record keeps its timestamp, so it keeps its ID.
  - The trigger context is carried inside the durable request and stored as workflow state. It is never parsed from the ID.
  - A re-published event is a new record and therefore a new run. Redelivery of the same record is deduplicated by Restate.
- **Bad records fail terminally** in the trigger handler. Examples: non-JSON, an adapter that rejects the record, or input that doesn't validate.
  - They are visible in `sys_invocation` as `[400] …`, never retried, and never block the topic.
  - The trigger handler takes `serde.binary` and parses the JSON itself, so a JSON parse error cannot trigger endless retries.
- **Disabling a Kafka trigger is eventually consistent.**
  - Deleting a subscription stops its consumer group, but records Restate already enqueued still run.
  - The API returns `observedStatus` (`active`/`disabling`/`disabled`/`pending`/`error`) and says so in the response.
  - Re-created subscriptions use a stable `group.id` (`wf.<name>.<triggerId>`), so they resume from committed offsets.
- **Artifact identity is a source digest, not the Docker image ID.**
  - Image IDs change on every rebuild because layer mtimes change.
  - `pipeline deploy` hashes the Dockerfile, the lockfile and workspace config, plus the unit's sources and those of its workspace dependencies. Test files are excluded.
  - The image is tagged `<version>-<digest12>`, and a build is skipped when that tag already exists.
- **Version rule.**
  - The same `name@version` with a different contract hash or artifact is rejected (409) in immutable mode.
  - Any source change, reformatting included, needs a version bump, or use `--dev`.
- **"Active" mirrors Restate routing.**
  - Re-registering an older, unchanged endpoint returns "Unchanged" and does **not** move routing back to it.
  - After each registration core-api reads `GET :9070/services/<name>` (`deployment_id`) and marks that deployment active; every other live one is draining.
- **Failed registrations don't leave orphans.** If `POST /v1/deployments` fails, `pipeline deploy` removes the container it just started.
- **Unit-local contracts.**
  - Shared contracts live in `packages/contracts`.
  - A unit may ship its own `export const contract` in `dist/contract.js`; the test fixture `versioned-sleeper` does.
  - This keeps fixture changes from altering production units' artifacts.
- **Tests import workspace sources through vitest aliases.**
  - Export conditions were tried first and broke third-party resolution: the `module` condition led to `@opentelemetry/api` ESM builds, and the `import` condition broke `pg`. A custom condition (`@ai-pipeline/source`) is safe, because no third-party package declares it — so it stays, as the declaration each alias is generated from.
  - The aliases are generated from each manifest's `exports`, one per subpath, and anchored as exact-match regexes: a bare string `find` in Vite also matches everything beneath it, which would rewrite `@ai-pipeline/runtime/retry` against the root entry point.
- **pnpm 11**:
  - build scripts are opt-in (`allowBuilds` in `pnpm-workspace.yaml`);
  - `pnpm deploy` needs `injectWorkspacePackages: true`;
  - `turbo prune` does not copy root files. The shared compiler config was therefore moved into
    `packages/typescript-config`, a real workspace package — prune now carries it as a dependency, the
    Dockerfile needs no `COPY`, and it is no longer a turbo `globalDependency` busting every cache.
- **Observability.**
  - Restate server spans, SDK hook spans (per attempt and per `ctx.run`) and LiteLLM generations share one trace.
  - `packages/ai` forwards W3C `traceparent` to LiteLLM, and `RunView.traceId` leads to it.
  - Langfuse 4.38 runs in "events only" mode, so read data through `/api/public/v2/observations`.
  - MinIO images are no longer published reliably, so the overlay uses SeaweedFS for Langfuse blobs, as the reference project did.

## Bug review (2026-09-22)

- **"Current" means routed, not most recent.** The catalogue's current definition of a unit is the version of its `active` deployment, i.e. the one Restate routes to.
  - Re-registering an older build no longer changes REST validation, triggers or subscriptions.
  - Triggers are synced only from a build that becomes active.
- **Registration is validated before Restate routes to it.**
  - `POST /deployments` with `dry_run` must show the endpoint serves the unit's service (and optionally its trigger service) and nothing else.
  - Failures after the real registration are returned as retryable `503 CATALOGUE_SYNC_FAILED`, because every later step is idempotent.
  - The CLI tears a container down only on refusals that happen before registration.
- **Serialisation.** Postgres advisory locks serialise registration (`register:<name>`) and trigger reconciliation (`reconcile:<name>`). `POST /subscriptions` is not idempotent, so concurrent reconciles could otherwise duplicate subscriptions.
- **Other guards:**
  - `metadata.config` is validated against the config schema when a build registers.
  - Retire refuses a deployment Restate still routes to, whatever the catalogue says.
  - A version's immutable artifact binding outlives the retirement of its deployments.
  - The Kafka cluster is re-ensured before subscribing.
  - Restate network errors map to `502 RESTATE_UNAVAILABLE`.
  - The Postgres pool has an idle-error listener; without one, a database restart would crash core-api.
- **CSRF.** With no auth, core-api refuses unsafe methods that come with a foreign `Origin` or `sec-fetch-site: cross-site|same-site`. The CLI and curl send neither, so they are unaffected.
- **LLM retries are uncapped.** `retry.llm` sets intervals only, so a gateway or model outage leaves the invocation retrying instead of failing the run. Measured 2026-09-24 with litellm stopped: the callees stay `backing-off` and do not reach `paused`, because an uncapped `ctx.run` never exhausts the invocation-level `maxAttempts`. A run's `blocked` reports both (see the 2026-09-24 review below). Non-retryable model errors (client 4xx) become `TerminalError`. The call is aborted when the Restate attempt ends (`attemptCompletedSignal`).
- **The replay test replays for real.**
  - Service-level `inactivityTimeout` overrides the server's always-replay setting, so the test forces `inactivityTimeout: 0` per service and pins `restate:1.7.10`.
  - It asserts that the workflow body ran more than once while the LLM step ran once.
- **Kafka persistence.**
  - The `apache/kafka` image writes to `/tmp/kafka-logs` by default, so compose now sets `KAFKA_LOG_DIRS` to the volume and pins `CLUSTER_ID`.
  - If a topic disappears while subscribed (e.g. the broker was recreated without its data), Restate's consumer stops with `UnknownTopicOrPartition` and does not recover. Toggling the trigger recreates the subscription: `PATCH …/triggers/<id>` `{enabled:false}` then `{enabled:true}`. It resumes from the committed offsets of its stable `group.id`.
- **Contracts and adapters.**
  - `SummaryInput.text` allows a workflow's title plus text.
  - The `content.published` adapter skips other object types before requiring the Content shape, and accepts a `null` title.
  - Trigger IDs are strict kebab-case and must not map to the same handler.
- **CLI.**
  - `pnpm pipeline` builds first; the contract comes from `dist/`.
  - `.env` is read with Node's `util.parseEnv`.
  - Secrets reach `docker run` through the environment, not argv.
  - A unit container is recreated when its runtime config (env, network) changes.
  - `retire` never removes a container still used by a live deployment.
  - The source digest skips dotfiles and symlinks and includes `.dockerignore`/`turbo.json`.
  - Builds clean `dist/`, and `tsconfig.base.json` is a turbo global dependency.

## Structure review (2026-09-23)

The POC worked, but it was laid out as "one folder per package, all code in `src/`". These are the
settled answers to that.

- **The repo follows Turborepo's recommended shape.**
  - Shared config lives in packages (`packages/typescript-config`, `packages/eslint-config`), not at
    the root. Each package's `tsconfig.json` is the inclusive one (tests included, so editors and
    type-aware lint see them) and `tsconfig.build.json` is the one that excludes tests from emit.
  - Root `package.json` only delegates to `turbo`. `pnpm check` is a single `turbo run` covering
    build, typecheck, lint, unit tests and formatting, followed by `turbo boundaries`.
  - The shared Vitest projects, the e2e typecheck/lint and repo-wide formatting stay root tasks
    (`//#test:unit`, `//#typecheck:tests`, `//#lint:tests`, `//#format:check`) — the documented
    exception for things that genuinely cannot be package tasks. None of them depends on `build`,
    because the unit suites resolve workspace packages to source and `tests/e2e` drives HTTP.
  - Versions shared by more than one package live in the `pnpm-workspace.yaml` `catalog:`.
- **No barrel files.** Every package exports one entry point per purpose, each declaring its source
  under the `@ai-pipeline/source` condition. That condition is now also the input to
  `vitest.config.ts`'s alias generation, so the module map is declared once.
  - Contracts are split into schemas (zod) and `api` (`restate.iface`). The registry imports schemas
    only, so **the deploy CLI no longer loads `@restatedev/restate-sdk`** — its only external
    dependency is zod. `services/summary` no longer pulls `kafkaTrigger` either.
- **`turbo boundaries` enforces the graph.** Tags in each package's `turbo.json`: `contract` may not
  depend on `runtime`/`unit`/`app`, `runtime` not on `unit`/`app`, `unit` not on `app`, and nothing
  may depend on an app. It also caught three packages using `vitest` without declaring it, which had
  been working only by hoisting.
- **ESLint, with the handler rules as lint.** CLAUDE.md's determinism rules (`Date.now`,
  `Math.random`, timers, native promise combinators) are now `no-restricted-*` rules applied to
  `services/*`, `workflows/*` and `packages/runtime`. Previously only the always-replay test could
  catch a breach, and only after the fact.
  - Two rules are deliberately off: `require-await`, because Fastify handlers and async ports are
    declared async by contract; and `consistent-type-definitions`, because an object-literal `type`
    carries an implicit index signature that an `interface` does not, and the Restate SDK's by-name
    clients constrain their generic to one.
  - The linter's first pass found real defects: `TriggerAdapter`'s `unknown | null` collapsed to
    `unknown` (the skip contract was never in the type), and every `JSON.parse` in the CLI flowed as
    `any` into the artifact digest and unit discovery.
- **`apps/core-api` is layered.** `routes/` and `plugins/` (HTTP) over `domain/` (rules) over
  `store/` (Postgres) and `restate/` (adapters), with `views.ts` owning every row→wire mapping.
  - `domain/` depends on interfaces — `Store`, `RestateAdminPort`, `IngressPort` — so the
    registration, retirement, run-start and reconciliation rules are tested against an in-memory
    catalogue and a fake Restate. Those 550 lines had no tests at all before.
  - Repositories return camelCase records, so no column name escapes `store/`.
  - Responses are serialized against JSON Schema generated from the API contract. That is a contract
    check — an undeclared field cannot be returned — and it is pinned by
    `routes/serialization.test.ts`, which proves opaque JSON (a unit's own input/output, a trigger
    envelope) passes through untouched while undeclared fields are dropped.
- **The HTTP surface is a shared contract** (`packages/api-contract`, zod only): request and response
  schemas, the error envelope, and the error-code union. core-api validates and serializes with it,
  the CLI is typed by it, and `tests/e2e` uses it instead of `any`.
  - It is a separate package, not a subpath of `packages/contracts`, because core-api deliberately
    never imports workflow contracts — a subpath would pull the Restate SDK and every workflow schema
    into the control plane. The boundaries tags keep it that way.
  - `PRE_REGISTRATION_CODES` lives there too, so the CLI's teardown rule and the server's ordering
    guarantee are one declaration rather than two copies.
- **The CLI is testable.** `deploy` takes a `Docker` port, so the rules that matter are covered:
  container reuse by config hash, retry on 502/503, the attempt limit, and "tear down only a
  container this deploy started, and only for a pre-registration refusal".
  - Workspace topology is read from `pnpm-workspace.yaml` instead of a hardcoded group list that was
    duplicated in three places.
  - `sourceDigest` gained the shared compiler config (a devDependency, which the dependency walk does
    not follow) and learned to ignore `src/testing/**` alongside `*.test.ts`, since neither ships.
  - A unit↔contract consistency test now fails the build when a `metadata.json` and its contract
    disagree; that mismatch used to surface only at deploy time.

## Review round two (2026-09-23)

Driven by a set of specific questions: how a workflow gets added, whether units are really
independent, whether the APIs suffice, where tables come from, whether observability works, what
SeaweedFS is for, dead code, over-engineering.

- **Units are independently deployable, and that was broken.** The artifact digest covers a unit's
  workspace dependencies, and every unit imported the whole of `packages/contracts` — so adding an
  unrelated workflow's contract changed the digest of every existing unit and would have forced a
  round of version bumps. Measured, then fixed:
  - a unit owns its contract (`src/contract.ts` → `dist/contract.js`), and the shared registry is
    gone. `packages/contract-*` exists only for a contract a second unit needs, which is why
    `contract-summary` is shared and `content-enrichment`'s is not;
  - the digest hashes the lockfile's external resolution graph (`packages:`, `snapshots:`) rather than
    the whole file. `turbo prune --docker` writes a pruned lockfile per image, so another package's
    `importers:` entry never reaches this unit's build — and `importers:` restates declared
    specifiers that every package.json in the closure already contributes.
  - Verified end to end: scaffolding a workflow with its own Kafka trigger, installing, and removing
    it again leaves both existing units' digests byte-identical.
- **Adding a unit is one command.** `pnpm pipeline new <kind> <name> [--kafka <topic>]` writes the
  thirteen files that have to agree — manifest with subpath exports, both tsconfigs, lint config,
  boundaries tag, metadata, contract, schemas, iface, handler, trigger, adapter, entry point. The
  generated unit passes `pnpm check` as it stands, and `scaffold.test.ts` checks the output against
  the same rules the toolchain enforces, so the templates cannot drift silently.
- **A workflow's entry handler must be `run`.** The runs API selects invocations by handler name, so a
  workflow that named it anything else would silently have no runs. It was an unenforced convention;
  `pipeline deploy` now refuses it.
- **Missing run-lifecycle APIs, found by taking the retry policy seriously.** The LLM profile is
  uncapped and pauses an invocation when retries are exhausted — deliberately, so an outage does not
  destroy a journal. But the API could only _report_ `paused`, so recovery needed the Restate CLI.
  Restate 1.7.10 exposes `PATCH /invocations/{id}/resume`, `…/kill`, `…/restart-as-new` and
  `…/purge`; the first two are now `POST /v1/runs/:workflow/:runId/{resume,kill}`. `restart-as-new`
  and the purge operations were left out: purging deletes history, and Restate's retention already
  governs that.
- **The cancellation regex is justified.** `mapStatus` distinguishes cancelled from failed by matching
  `[409] Cancel` in `completion_failure`. Checked against the live server: `sys_invocation` in 1.7.10
  has no column that states it — `completion_result` is only `success`/`failure`. The custom code
  stays, and the coupling is now written down rather than assumed.
- **Tables come from provisioning, not from the application.** `infra/postgres/init/` is mounted into
  `/docker-entrypoint-initdb.d`; in a real environment the same SQL is applied by whatever provisions
  the database. The API assumes the tables exist, issues no DDL, and therefore needs no such
  privileges. `schema.test.ts` derives the table names from the repositories' SQL and fails the build
  if provisioning does not create one.
  - A migration runner was built first and then removed: it was more machinery than this needs, and
    the instruction was explicit that the schema belongs with the database. Worth recording that the
    runner's own config had to be narrowed to `DATABASE_URL` — demanding the API's Restate settings
    would have failed a job that never used them.
- **Observability works, with one gap.** Restate server and SDK spans, service spans and the LiteLLM
  generation share one trace per run, and `RunView.traceId` leads to it — confirmed through the
  Langfuse API. The generation carries latency but not token usage or cost: `langfuse_otel` does not
  emit the `gen_ai.usage.*` attributes Langfuse maps those from. LiteLLM's native `langfuse` callback
  does, but creates its own trace and would break the single-trace property, which is the more
  valuable of the two. The README says so rather than implying cost tracking works.
  - The base collector config has only a debug exporter: without the overlay, spans are received and
    dropped. That is intentional for a local stack, but it is not "tracing is on".
- **SeaweedFS stays.** It is not spare parts: Langfuse v3+ requires S3-compatible storage for event
  and media uploads, and both `LANGFUSE_S3_*_ENDPOINT` settings point at it. Confirmed in use — 89
  objects after a handful of runs. It is in the observability overlay only, so the base stack does not
  pay for it.
- **Two N+1s in the read paths, fixed.** `GET /v1/workflows` fetched the global subscription list once
  per catalogued unit (Restate has no per-service endpoint), and `GET /v1/deployments` ran one
  in-flight count per deployment — dozens of queries for one request once fixture history had
  accumulated. Both now issue one call, and a test pins the count so it cannot regress.
- **Dead code: one finding.** `startContainer` was declared on the `Docker` port, implemented, wired
  into `dockerCli` and stubbed in tests, and never called — the e2e suite starts containers directly.
  Removed. A sweep of every exported symbol turned up nothing else: the rest of what a naive scan
  flags is same-file use, and the inferred types a contract package exports next to each schema are a
  published surface, not dead weight.
- **Over-engineering, judged case by case.** The abstractions that survived review earn their keep:
  the `Store` and port interfaces are what make the control-plane rules testable without Postgres or
  Restate, and the scaffold replaces thirteen hand-written files. What was removed or avoided: the
  migration runner, the contract registry, and `startContainer`. Advisory locks stay rather than
  becoming a Restate virtual object — turning the control plane into a Restate service to borrow its
  serialisation would be a far larger change than two `pg_advisory_lock` calls, and core-api is
  deliberately not a Restate service.

## External review (2026-09-24)

An outside agent reviewed the tree against `docs/review-brief.md`. Most of what it found was real;
some of what it recommended was not, and the difference is recorded here so it is not re-litigated.

**Fixed.** A blank `body` in the DIKSHA adapter beat a perfectly good transcript, because `??` falls
through only on nullish and the schema types the field `.nullish()` — a Live Content with usable text
failed terminally. A paused _child_ invocation was unreachable through the runs API (below). A unit
could change its own `restateName` or `kind` on a version bump. A declared dependency's `kind` was
never checked against the catalogue. `metadata.json` accepted a second REST trigger the start path
could never reach. Retirement decided whether an endpoint was still wanted from a snapshot taken
before the retire.

**What "resumable" means now.** `retryPolicy.onMaxAttempts: 'pause'` applies per invocation, and what
stops making progress during a model outage is a _service_, not the workflow — which is only
suspended waiting for it, so the run reads `running`. `GET /v1/runs/:workflow/:runId` therefore
reports those calls in `blocked`, and `POST …/resume` takes an `invocationId` naming one of them.
Restate holds the relationship (`invoked_by_id` in `sys_invocation`); nothing here tracks it. Direct
children only, because the call graph is workflow → service, and only on a single-run read —
collecting it per row would be one query per run on the list path.

Drilling it corrected a claim made further up this file: with litellm stopped, the callees sit in
`backing-off`, not `paused`, because `retry.llm` is uncapped and so never exhausts the invocation's
`maxAttempts`. `blocked` therefore reports both and says which is which — a `paused` call is
resumable, a `backing-off` one needs the gateway back. Reporting only `paused` would have answered
"why is this run stuck?" with silence in exactly the case the field exists for.

**A unit's Restate identity is immutable.** `name → restateName` and `name → kind` cannot change once
a unit is catalogued (`UNIT_IDENTITY_CHANGED`). The runs API resolves a run through the _current_
Restate name, and a workflow owns the Kafka subscriptions under a sink prefix built from it — so a
rename hides old runs and orphans a consumer that keeps reading into a trigger service nothing routes
to. Renaming is a migration: retire what the old name owns, or deploy under a new catalogue name.

**Contracts must evolve compatibly under a stable Restate name.** Restate pins an _invocation_ to the
deployment it started on, not a whole call graph: an in-flight workflow's later call to a service
resolves to whatever serves that service name at the moment it is made. Keeping the old parent's
container alive does not make a new callee compatible with it. So a version bump under a stable
`restateName` must stay backward compatible at the handler boundary, and a breaking protocol change
needs a new `restateName` — which the identity rule above turns into a deliberate new unit rather
than a routine bump. Nothing here routes by version; adding that would be a far bigger machine than
the rule.

**The registration window is accepted, not closed.** Registration hands the endpoint to Restate
before it commits the catalogue, so a request arriving in between is validated against the outgoing
version's schema and reaches the incoming one. Both ends fail closed — the API validates against the
catalogued schema, and `restate.iface.schemas` validates again at the handler — so the worst case is
a visibly failed run, not a silently misread one, and a retry converges. An admission gate sharing
`register:<name>` would put a Postgres advisory lock on every run submission and still not make two
systems atomic.

**Idempotency-key reuse detection is best-effort.** The digest is compared against what the run
recorded, and the handler records it as its first act, so a second submit that arrives before it does
is answered `PreviouslyAccepted` without a comparison. Failing closed would 5xx a client retrying in
the first milliseconds, which is the _correct_ use of a key; storing the digest here would mean a run
table. `PreviouslyAccepted` is honest either way: it says the key already has a run, never that the
body just sent is the one running.

**Input size is bounded by the contract; the prompt is bounded by the model.** The contract maxima
(110k chars for `summary`, ~40k for the authoring chain) say what a caller may send. `num_ctx: 8192`
in `infra/litellm/config.yaml` says what the model reads, and it is smaller — Ollama truncates rather
than erroring, so an oversized input costs quality, not a failed run. A known limit, stated rather
than enforced: token budgets and chunking are worth building when a real corpus needs them, and
`schemas.test.ts` already pins the arithmetic between a workflow and its callees.

**What the words mean on the wire.**

- `Accepted` / `PreviouslyAccepted` — Restate took the submission; `PreviouslyAccepted` means this
  run id already existed.
- `active`, of a deployment — Restate routes new invocations here. Of a trigger — Restate holds the
  subscription. Neither means records are being consumed; see P1-1 in `docs/qa-report.md`.
- `paused` — an invocation exhausted `maxAttempts` and kept its journal, waiting to be resumed.
- `disabling` — the subscription is gone or going, but records already enqueued still run.
- `retired` — the deployment is deregistered, which is refused while anything is pinned to it.
- Run history is Restate's 7-day retention, and operational history rather than an audit log.

**Not done, and why.** A Kafka lag watchdog: built once and removed in favour of the librdkafka
timeouts (P1-1), and rebuilding it would re-add the machinery that removal was the point of. An
authenticated boundary: still v2, below. Failing closed on missing idempotency evidence, an admission
gate, and per-model token budgets: above. Pruning the lockfile to a unit's own closure for the
artifact digest: `artifact.ts` keeps `packages:`/`snapshots:` whole on purpose, so it over-invalidates
(extra version bumps) rather than under-invalidates (shipping stale bytes), and that is the safe
direction.

## Production on Kubernetes

Local development runs on Docker Compose and `pnpm pipeline deploy`, which builds an image, starts a
container and registers it. **In production the CLI is not in the path**: a Deployment serves each
unit and the [Restate Operator][k8s] takes over registration and drain — which is why it is listed as
deferred below rather than as missing.

The operator's `RestateDeployment` CRD is the same model this repo already enforces by hand: it keeps
the old ReplicaSet and its Service alive so in-flight invocations drain against the code they started
on. So the move is a substitution, not a redesign.

What moves, and what does not:

- **Keeps working as-is:** the catalogue, registration, trigger reconciliation and the runs API.
  core-api talks to Restate's admin API and to Postgres; neither cares what started the runtime.
- **Belongs to the platform:** building images, container lifecycle, rollout and rollback, secrets.
  The two container-lifecycle sharp edges the review found are local-dev only for this reason — a
  deploy replacing a container in place (`ensureContainer`) and retirement removing one from a list
  that can be stale. Both are `docker rm -f` in the CLI. A Deployment does not have them.
- **Must survive the move:** one immutable endpoint per artifact, registered only once it is
  serving, and retired only once drained. That is what keeps in-flight invocations pinned to code
  that still exists.
- **Must be added before shared exposure:** an authenticated boundary. There is none (see below);
  the guards in `plugins/security.ts` are a Host allow-list and a cross-site check, which stop a
  browser, not a client. Restate's admin and ingress ports stay inside the cluster.

[k8s]: https://docs.restate.dev/services/deploy/kubernetes

## Deferred (v2+)

RAG:

- `RagIngestionWorkflow`, plus Chunk, Embedding and VectorStore services on pgvector, with Mastra where it applies.

Access and interfaces:

- MCP server and tools registry.
- Auth and tenant scoping.

Execution:

- Cron (a self-rescheduling virtual object; Restate has no native cron).
- Human-in-the-loop review gates (awakeables or workflow promises).

Operations:

- The Kubernetes Restate Operator, which would take over deploy and drain.
