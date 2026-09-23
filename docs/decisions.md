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
- **LLM retries are uncapped.** `retry.llm` sets intervals only, so a gateway or model outage pauses the invocation (resumable) instead of failing the run. Non-retryable model errors (client 4xx) become `TerminalError`. The call is aborted when the Restate attempt ends (`attemptCompletedSignal`).
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
