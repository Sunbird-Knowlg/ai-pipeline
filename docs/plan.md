# AI Pipeline on Restate — v1 POC plan

> **Key principle: the framework must not reimplement Restate.**
>
> - **Restate owns:** durability, execution, retries, invocation state, service-to-service communication, concurrency, and routing between deployments.
> - **The AI Pipeline framework owns:** workflow discovery, contracts, trigger configuration and transformation, model adapters, catalogue metadata, and the external management APIs.

## Context

`/Users/ravinderkumar/workspace/ai-pipeline` is a working AI-pipeline platform built on **Temporal, Mastra, LiteLLM and n8n**:

- pipeline specs are YAML files in git;
- one Fastify API serves everything;
- Temporal is the run store.

We are building a **new, Restate-native sibling** in `/Users/ravinderkumar/workspace/ai-pipeline-restate`, following the attached high-level design:

- **Restate** is the durable runtime.
- **Kafka and REST** are the triggers; n8n is not used.
- A **Postgres catalogue** (the control-plane store) is fed by each deployable's `metadata.json`.
- A **core service** provides the workflow, catalogue and run APIs.

v1 is a proof of concept with one real example: the `ContentEnrichment` workflow, which calls a reusable `SummaryService`. It is triggered either from the API or from Kafka.

Revision 2 of this plan applies an architecture review. It makes deployments immutable, turns reusable units into real Restate services, keeps one contract source, uses the official Restate clients, separates runtime from control plane, and orders the build test-first.

## Decisions

| Topic             | Decision                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Restate server 1.7.10 with TS SDK 1.17.2 (npm-verified 2026-09-21). Uses the 1.17 `restate.iface` / `restate.implement` contract APIs                                                                                                                                                    |
| Building blocks   | **Step**: plain function run inside a handler, recorded in the caller's journal, not catalogued.<br>**Service**: reusable capability with its own Restate invocation, catalogued.<br>**Workflow**: stateful orchestration with a unique run ID, catalogued                               |
| Example           | `ContentEnrichment` workflow receives REST or Kafka `content.published`. It makes a durable call to the **private** `SummaryService`, then returns `{ summary, metadata }`. The metadata is a placeholder for now                                                                        |
| Triggers          | REST goes only through the core API; the Restate ingress is not published. Kafka uses **Restate-native subscriptions** into a thin `ContentEnrichmentTrigger/onEvent`. A **trigger adapter** maps the event to the workflow input. No n8n, no cron                                       |
| Contracts         | **One source**: zod schemas plus `restate.iface` in `packages/contracts`. The deploy CLI generates the catalogue's JSON Schemas from them. `metadata.json` holds operational metadata only                                                                                               |
| Deployment        | **Immutable deployments.** Each build is registered at its own endpoint (`content-enrichment-<digest>:9080`). In-flight invocations finish on their original deployment, which is retired once drained. `--dev` mode re-uses one endpoint with `force: true`, for local development only |
| Registration      | **Control plane, not runtime.** Workflow and service processes only serve Restate handlers. `pnpm pipeline deploy <name>` starts the container, then calls the core API. The core API registers the deployment with Restate, updates the catalogue and reconciles triggers               |
| Run store         | Restate (introspection SQL, workflow state, ingress output). Workflow and journal retention are 7 days, so this is operational history, not an audit store. There is no run table                                                                                                        |
| LLM               | Vercel AI SDK `generateText` with `@ai-sdk/openai-compatible`, through LiteLLM, to host Ollama (`qwen3.5:4b`, `think: false`). It sits inside `ctx.run` behind `packages/ai`. Mastra comes back in v2 as an agent/RAG adapter where it adds value                                        |
| Auth              | None. Every published port is bound to `127.0.0.1`                                                                                                                                                                                                                                       |
| Observability     | OTel collector always on. Langfuse is an overlay (`compose.observability.yaml`)                                                                                                                                                                                                          |
| Monorepo / deploy | pnpm with Turborepo, strict ESM TypeScript. Docker Compose runs infra and core-api; the deploy CLI runs the workflow and service containers                                                                                                                                              |
| Out of v1         | RAG (v2: `RagIngestionWorkflow` plus Chunk/Embedding/VectorStore services on pgvector), MCP, cron, human-in-the-loop, auth                                                                                                                                                               |

**Interview answers superseded by the review:**

- In-process `summary` → a Restate `SummaryService`.
- Replace-in-place deploys → immutable deployments.
- Self-registration on boot → control-plane registration.
- Mastra Agent → AI SDK for v1.
- Schemas inline in `metadata.json` → contract package.

## Verified facts the design relies on

**Kafka clusters and subscriptions**

- Register clusters at runtime with `POST :9070/kafka-clusters {name, properties:{"bootstrap.servers"}}`. A 409 means it already exists.
- Create subscriptions with `POST :9070/subscriptions {source:"kafka://<cluster>/<topic>", sink:"service://<Svc>/<handler>", options:{"group.id","auto.offset.reset"}}`.
  - The POST is not idempotent, so list and diff first.
  - Order matters: cluster, then deployment, then subscription.
  - There is no PATCH; delete and recreate instead.
- Deleting a subscription stops its consumer group, but **records Restate already enqueued still get processed**. So "disabled" is eventually consistent.
- **Documented** handler headers: `restate.subscription.id`, `kafka.offset`, `kafka.partition`, `kafka.timestamp`.
  - `kafka.topic` and `kafka.key` exist only in the server source, so we don't depend on them. Cluster, topic and trigger ID come from the trigger definition.
  - Kafka record headers are not forwarded.
- Restate deduplicates records per subscription.
- Sinking straight into a workflow's `run` handler makes the record key the workflow ID, and keyless records collapse onto `""`. That is why a thin service trigger sits in between.

**Deployments**

- A registered URI is an immutable deployment, and new invocations go to the latest revision of a service.
- In-flight invocations are pinned (`sys_invocation.pinned_deployment_id`), so the old endpoint must stay up until they drain.
- `force` is for local development only. Overwriting a URI can cause journal-mismatch failures.
- Retire a deployment with `DELETE /deployments/{id}?force=true` once it has drained.
- On unprefixed routes, `POST /deployments` defaults `force` to false.

**Clients and SDK**

- `@restatedev/restate-sdk-clients` provides `connect`, `workflowClient({name}, id).workflowSubmit / workflowOutput / workflowAttach`, and `result`. The core API uses it for all ingress calls.
- Admin HTTP covers the control plane: deployments, subscriptions, Kafka clusters, `POST /query`, and `PATCH /invocations/{id}/cancel`.
- Useful `sys_invocation` columns: `id`, `target_service_name`, `target_handler_name`, `target_service_key`, `status`, `completion_result`, `completion_failure`, `created_at`, `completed_at`, `pinned_deployment_id`, `trace_id`.
- Workflow K/V state can be queried in the `state` table (`service_name`, `service_key`, `key`, `value_utf8`).
- `ingressPrivate: true` blocks HTTP and Kafka ingress but still allows service-to-service calls.
- `restate.serde.schema(zod)` needs Zod 4.2 or later.
- Only `RestatePromise.all`/`race` may combine durable work.
- The SDK's invocation `retryPolicy` accepts `onMaxAttempts: "pause"`. `ctx.run` accepts `RunOptions` (`maxRetryAttempts`, `initialRetryInterval`, `maxRetryInterval`, `maxRetryDuration`).

**LLM calls**

- LiteLLM `model_name`s must not contain slashes.
- Set `maxRetries: 0` in the AI SDK and `num_retries: 0` in LiteLLM, so Restate owns retries.

**Schemas**

- zod's `toJSONSchema` defaults to draft 2020-12, so generate with `{ target: 'draft-07', io: 'input' }` for Ajv.

**Tracing**

- Server: `RESTATE_TRACING_ENDPOINT=otlp+http://otel:4318/v1/traces`.
- SDK: `openTelemetryHook({tracer})` in service `options.hooks`.
- LLM traces, tokens and cost: LiteLLM `callbacks: ["langfuse_otel"]` in the overlay.

**To confirm while implementing** (with the Restate skill and docs MCP): the exact send-client name for an iface-typed workflow call from a handler (`ctx.workflowSendClient` vs `ctx.sendClient(iface, key)`).

## Repository layout

```
ai-pipeline-restate/
├─ package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  vitest.config.ts  .prettierrc.json
├─ .dockerignore  .env.example  .mcp.json  .claude/{settings.json,kafka-mcp.yaml}  CLAUDE.md  README.md  docs/{plan,decisions}.md
├─ Dockerfile                  # ARG PACKAGE: turbo prune → pnpm install → turbo build → pnpm deploy → node:24-slim, non-root
├─ compose.yaml                # postgres, kafka(+init), restate, litellm, otel, core-api   (runtime containers come from the CLI)
├─ compose.observability.yaml  # overlay: Langfuse (web, worker, clickhouse, redis, minio) + otel→Langfuse + LiteLLM callback
├─ infra/  litellm/{config,config.langfuse}.yaml  otel/{config,langfuse}.yaml  postgres/init.sh
├─ packages/
│  ├─ contracts/      zod schemas + restate.iface per service/workflow + config schemas; index maps name → contract
│  ├─ runtime/        SMALL: trigger envelope + kafkaTrigger(), retry profiles, config loader, serve(), logging
│  ├─ ai/             model.ts (LiteLLM via @ai-sdk/openai-compatible), generate.ts; providers stay behind this
│  ├─ metadata/       zod schema + types for metadata.json
│  └─ observability/  pino + minimal OTel NodeSDK (only when OTEL_EXPORTER_OTLP_ENDPOINT is set)
├─ services/
│  └─ summary/                 SummaryService (private)          metadata.json  src/{index,main}.ts
├─ workflows/
│  └─ content-enrichment/      ContentEnrichment + …Trigger       metadata.json  src/{index,adapters,main}.ts
├─ apps/
│  ├─ core-api/                REST gateway + catalogue + runs + control plane (Restate admin, reconcile)
│  └─ cli/                     `pipeline deploy|deployments|retire|runs` → docker + core API
└─ tests/
   ├─ fixtures/versioned-sleeper/   test-only workflow (v1/v2) for versioning + crash tests
   └─ e2e/                          vitest e2e suites against the compose stack
```

- Reusable in-process logic, such as text statistics, lives as **steps**: plain functions in the owning package, or `packages/steps-*` once shared. Steps are never catalogued.
- `packages/runtime` must stay small. If it grows toward a new programming model, stop and use Restate directly.

## Contracts (`packages/contracts`) — the single source of types and schemas

```ts
export const SummaryInput = z.object({
  text: z.string().min(1),
  maxWords: z.number().int().positive(),
});
export const SummaryOutput = z.object({ summary: z.string(), model: z.string() });
export const SummaryConfig = z.object({ model: z.string() });
export const summaryApi = restate.iface.service('SummaryService', {
  summarize: restate.iface.schemas({ input: SummaryInput, output: SummaryOutput }),
});

export const ContentInput = z.object({
  contentId: z.string(),
  title: z.string().optional(),
  text: z.string().min(1).max(100_000),
});
export const RunEnvelope = <T extends z.ZodType>(input: T) =>
  z.object({ input, trigger: TriggerContext });
export const contentEnrichmentApi = restate.iface.workflow('ContentEnrichment', {
  run: restate.iface.schemas({ input: RunEnvelope(ContentInput), output: ContentOutput }),
});
```

- The implementation (`restate.implement(summaryApi, {...})`) and its callers (`ctx` clients in handlers) import the same interface.
- The core API stays generic: it calls workflows **by name** and never imports contracts at runtime.
- The deploy CLI imports `contracts[name]` and generates `input`, `output` and `config` JSON Schemas with `z.toJSONSchema(…, { target: 'draft-07' })`. It computes `contractHash = sha256(canonical schemas)` and sends both with the deployment.
- The catalogue stores those schemas for display and Ajv validation of REST input. They are never hand-written.

`TriggerContext` = `{ type: 'rest' | 'kafka', id, source?, partition?, offset?, idempotencyKey?, receivedAt }`. It is carried **inside** the durable request, and the workflow stores it as state so the runs API can read it. It is never parsed back out of the run ID.

## metadata.json — operational metadata only

```json
{
  "apiVersion": "ai-pipeline/v1alpha1",
  "kind": "workflow",
  "name": "content-enrichment",
  "restateName": "ContentEnrichment",
  "version": "0.1.0",
  "description": "Enrich published content",
  "config": { "summaryMaxWords": 120 },
  "triggers": [
    { "id": "api", "type": "rest" },
    {
      "id": "content-published",
      "type": "kafka",
      "cluster": "local",
      "topic": "content.published",
      "adapter": "contentPublished"
    }
  ],
  "dependencies": [{ "kind": "service", "name": "summary" }]
}
```

`services/summary/metadata.json` has the same shape, with these values:

- `kind: "service"` and `restateName: "SummaryService"`;
- `visibility: "private"`;
- `config: { "model": "chat-default" }`;
- `triggers: []`.

The runtime validates `config` against the contract's config schema at boot.

## Runtime (`packages/runtime`) — conventions and helpers, not an engine

Handlers use the Restate context directly: `ctx.run`, `ctx.serviceClient`, `ctx.workflowSendClient`, `ctx.date.now()` and `RestatePromise.all`. The package adds only four things:

- **`retry` profiles**: presets for `ctx.run` `RunOptions` that developers can override.
  - `retry.llm`: 4 attempts, 2 s to 30 s.
  - `retry.http`: 5 attempts, 0.5 s to 10 s.
  - `retry.db`: 3 attempts, 100 ms to 1 s.
  - Invalid input and business-rule failures throw `TerminalError` straight away.
  - Unexpected bugs fall to the invocation-level `retryPolicy`: `{ maxAttempts: 10, onMaxAttempts: 'pause' }`, which pauses the invocation without losing its state.
- **`serviceOptions`**: shared defaults for `workflowRetention` (7 d), `journalRetention` (7 d), `inactivityTimeout` (5 min), `abortTimeout` (15 min), `retryPolicy` and `hooks: [openTelemetryHook]`. Services add `ingressPrivate: true` when their metadata says `private`.
- **`kafkaTrigger({ workflow: contentEnrichmentApi, metadata, adapters })`**: builds the `…Trigger` service with one `onEvent` handler, which does the following:
  1. Reads `partition` and `offset` from the documented headers, and the cluster, topic and trigger ID from the trigger definition.
  2. Runs the trigger's **adapter**, a pure `(event) => WorkflowInput | null`. `null` means skip. The adapter output is validated with the contract's input schema; an invalid event is logged and throws `TerminalError`, so it is not retried.
  3. Sets `runId = "kf_" + sha256("kafka:" + cluster + ":" + triggerId + ":" + topic + ":" + partition + ":" + offset)[0..32]`.
  4. Calls `ctx.workflowSendClient(contentEnrichmentApi, runId).run({ input, trigger })`.
- **`serve({ services, port })`**: `restate.serve` plus the logger and OTel setup. It does no registration.
- **`loadConfig(metadata, schema)`**.

A workflow records its trigger context and version at the start of `run` with `ctx.set('trigger', …)` and `ctx.set('version', …)`. It does this directly; there is no wrapper.

## The example

**`SummaryService`** (`services/summary`, private)

- Implements `summaryApi.summarize(ctx, {text, maxWords})`.
- Calls `ctx.run('llm.generate-summary', () => ai.generate({ model: config.model, system: SUMMARY_PROMPT, prompt: …, maxOutputTokens }), retry.llm)` and returns `{ summary, model }`.

**`ContentEnrichment`** (`workflows/content-enrichment`)

1. `run(ctx, { input, trigger })` sets the `trigger` and `version` state.
2. It calls the summary with a native durable call: `const s = await ctx.serviceClient(summaryApi).summarize({ text: input.text, maxWords: config.summaryMaxWords })`.
3. It computes step functions deterministically: `wordCount`, `charCount`, `readingTimeMinutes`.
4. It returns `{ contentId, summary: s.summary, metadata: { …stats, model: s.model, trigger: trigger.type, enrichedAt: await ctx.date.now() } }`.

The same process also serves `ContentEnrichmentTrigger`, built by `kafkaTrigger(...)`. Its adapter `contentPublished` maps a `content.published` event (for example `{ identifier, objectType, edata: { title, body } }`) to `ContentInput`.

**`AI` package**

- `model.ts` creates `createOpenAICompatible({ name: 'litellm', baseURL: LITELLM_URL + '/v1', apiKey })`.
- `generate.ts` wraps `generateText` with `maxRetries: 0` and returns `{ text, model, usage }`.
- Providers stay behind this package; workflows never see them.

## Core API (`apps/core-api`, Fastify 5): gateway, catalogue, runs, control plane

**Catalogue schema**: `schema.sql`, idempotent, applied on boot.

- **`workflow_definitions`** `(name, version, kind, restate_name, visibility, metadata jsonb, input_schema, output_schema, config_schema jsonb, contract_hash, created_at, PK(name, version))`
- **`workflow_deployments`** `(deployment_id PK, name, version, endpoint_uri, artifact_digest, mode dev|immutable, status active|draining|retired, registered_at, drained_at)`
- **`workflow_dependencies`** `(name, version, dependency_name, dependency_kind, PK(name, version, dependency_name))`
- **`workflow_triggers`** `(name, trigger_id, type, definition jsonb, desired_enabled bool, subscription_id, observed_status, last_error, updated_at, PK(name, trigger_id))`

**Rules**

- A registration with the same `name` and `version` but a different `contract_hash` or `artifact_digest` returns **409** in `immutable` mode. It is allowed in `dev` mode.
- The version is a semantic contract version. The artifact is the image digest. The deployment is Restate's `dp_…`. These are three distinct records.

**Boot**

1. Apply the schema.
2. Ensure the Kafka cluster (`POST :9070/kafka-clusters`), retrying until Restate is up; 409 is OK.
3. Listen on `:3000`.

**Other settings**

- Env config is validated by one zod schema.
- The host guard `ALLOWED_HOSTS` defaults to `localhost,127.0.0.1,::1,core-api`.
- The error envelope is `{ error: { code, message } }`, using `PipelineError` ported from reference `packages/core/src/errors.ts`.
- Ingress calls use `@restatedev/restate-sdk-clients`. Admin calls go through a small typed client in `src/restate-admin.ts`.

| Area          | Route                                                                                        | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane | `POST /v1/deployments` `{ metadata, schemas, contractHash, artifactDigest, endpoint, mode }` | 1. Validate `metadata` and compile the schemas with Ajv.<br>2. Apply the version/artifact rule.<br>3. Check that dependencies exist in Restate (`GET /services/<restateName>`).<br>4. `POST /deployments { uri, force: mode === 'dev' }`.<br>5. In one transaction, upsert the definition, deployment, dependencies and triggers. Mark earlier deployments of the same name `draining`.<br>6. Reconcile Kafka triggers: list subscriptions by sink, create the desired ones that are missing (`group.id = wf.<name>.<triggerId>`, `auto.offset.reset = earliest`), delete the undesired ones.<br>7. Return `{ deploymentId, triggers }` |
| Control plane | `GET /v1/deployments?name=`                                                                  | Deployments, each with its in-flight count (`SELECT count(*) FROM sys_invocation WHERE pinned_deployment_id = … AND status <> 'completed'`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Control plane | `DELETE /v1/deployments/:id`                                                                 | Retire. Returns 409 unless in-flight is 0 and it is not the latest. Otherwise `DELETE :9070/deployments/{id}?force=true`, sets status `retired` and `drained_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Catalogue     | `GET /v1/workflows?kind=`, `GET /v1/workflows/:name`                                         | Definitions (versions, schemas, dependencies, deployments), and triggers with `desiredEnabled` and `observedStatus` (`active` / `disabling` / `disabled` / `error`) read live from `GET :9070/subscriptions`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Catalogue     | `PATCH /v1/workflows/:name/triggers/:id` `{ enabled }`                                       | Sets desired state and reconciles. For Kafka: the subscription is deleted or created, and the status shows `disabling` until the subscription is gone. For REST: API runs are rejected or allowed. The response documents that already-enqueued records may still run                                                                                                                                                                                                                                                                                                                                                                   |
| Workflows     | `POST /v1/workflows/:name/runs` `{ input }`, optional `Idempotency-Key`                      | The workflow must be `kind: workflow`, active, and have its REST trigger enabled. Ajv-validate `input`. Set `runId = "api_" + sha256(key)[0..32]` or `api_` + a UUIDv7. Call `workflowClient({ name: restateName }, runId).workflowSubmit({ input, trigger })`. Returns 202 `{ runId, invocationId, status: Accepted \| PreviouslyAccepted }` plus `Location`                                                                                                                                                                                                                                                                           |
| Runs          | `GET /v1/runs?workflow=&status=&limit=50&cursor=`                                            | `POST :9070/query` on `sys_invocation` (`target_handler_name='run'`, catalogue workflows). Keyset pagination on `(created_at, id)`; identifiers are validated and literals quoted. It is joined with `state` rows `trigger` and `version`. Returns `RunView[]` plus `nextCursor`                                                                                                                                                                                                                                                                                                                                                        |
| Runs          | `GET /v1/runs/:workflow/:runId`                                                              | `RunView`, plus `workflowOutput()` once completed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Runs          | `POST /v1/runs/:workflow/:runId/cancel`                                                      | Look up the invocation ID in `sys_invocation`, `PATCH :9070/invocations/{id}/cancel`, return 202                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Health        | `GET /health/live`, `GET /health/ready`                                                      | Ready means Postgres and the Restate admin `/health` both respond                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`RunView` = `{ runId, invocationId, workflow, workflowVersion, deploymentId, status, restateStatus, trigger, createdAt, completedAt, traceId, error }`, where `status` is one of `running`, `completed`, `failed`, `cancelled` or `paused`.

## Deploy CLI (`apps/cli`, `pnpm pipeline …`)

**`deploy <name> [--dev]`**

1. `docker build --build-arg PACKAGE=<pkg>`. The artifact digest is the image ID.
2. Start the container on the compose network as `<name>-<digest12>`; with `--dev`, as `<name>-dev`, replacing the previous dev container.
3. Wait for the port to open.
4. Import `contracts[name]` to generate the schemas and the contract hash.
5. `POST /v1/deployments`.
6. Print the triggers and the older deployments that are now draining.

**Other commands**

- `deployments <name>` lists deployments with their in-flight counts.
- `retire <deploymentId>` calls `DELETE /v1/deployments/:id`, then stops the container.
- `runs [workflow]` / `run <workflow> <runId>` are thin API clients.

Deploy order: `summary`, then `content-enrichment`. Registration fails with a clear error if a dependency isn't deployed yet.

## Infrastructure

All published ports are `127.0.0.1:` only.

| Service            | Image                                          | Notes                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| postgres           | `postgres:17.11-bookworm`                      | Databases `pipeline` and `langfuse` (overlay). Healthcheck `pg_isready`                                                                                                                        |
| kafka              | `apache/kafka:4.3.1`                           | KRaft single node. Listeners `kafka:9092` (in-network) and `localhost:29092` (host)                                                                                                            |
| kafka-init         | `apache/kafka:4.3.1`                           | One-shot job that creates `content.published`                                                                                                                                                  |
| restate            | `docker.restate.dev/restatedev/restate:1.7.10` | 9070 (admin and UI) published; the 8080 ingress stays internal. `restate-data` volume. Tracing goes to otel. Healthcheck `curl -sf :9070/health`                                               |
| litellm            | `ghcr.io/berriai/litellm:v1.101.0`             | `chat-default` → `ollama_chat/qwen3.5:4b` (`think: false`), `num_retries: 0`, `api_base: http://host.docker.internal:11434` with `extra_hosts: host-gateway`. Healthcheck `/health/liveliness` |
| otel               | `otel/opentelemetry-collector-contrib:0.161.0` | OTLP/HTTP on 4318, `debug` exporter (the overlay switches it to Langfuse)                                                                                                                      |
| core-api           | built `@ai-pipeline/core-api`                  | Port 3000. Depends on postgres (healthy), restate (healthy) and kafka-init (completed)                                                                                                         |
| runtime containers | built by `pipeline deploy`                     | On the compose network, port 9080 internal, env from `.env`                                                                                                                                    |

**Dockerfile**

- `node:24-bookworm-slim`, because the AI SDK needs Node 22 or later.
- `pnpm deploy` needs `injectWorkspacePackages: true`; confirm this for the installed pnpm major.
- `files: ["dist", "metadata.json"]` in each runtime package.

## Implementation order (test-first; generalise only what repeats)

0. **Dev tooling and `CLAUDE.md`** (the key principle above, the building-block vocabulary, and the conventions) as the first commit. See below.
1. **Scaffold, contracts and a minimal plain-Restate workflow.** No Kafka and no LLM yet. Prove submit, result and idempotency through the official client against `restate` in compose.
2. **Immutable deployment and versioning** using `tests/fixtures/versioned-sleeper`:
   1. Deploy v1 and start a long invocation (a durable `ctx.sleep`).
   2. Deploy v2.
   3. Assert that the old run finishes on v1's deployment ID, new runs hit v2, and retiring v1 is refused until it drains.
      This builds the CLI `deploy`/`retire` and the control-plane deployment routes.
3. **Core API.** REST goes through the official client to the workflow. Build the catalogue tables and the workflow and run routes.
4. **Kafka native subscription.** Kafka goes through the thin trigger service and adapter to the workflow. Prove duplicate and redelivery behaviour: the same record gives one run, and re-publishing gives a new run.
5. **`SummaryService` composition.** `ContentEnrichment` makes a native durable call to the private service. Direct ingress to `SummaryService` must be rejected.
6. **LLM adapter.** `packages/ai` calls LiteLLM from inside `ctx.run`.
7. **Crash tests.** `docker kill` the content-enrichment container during the summary call, and again right after it returns. Restart it and assert the run completes, and that the LLM step is not re-executed once journaled (checked by LiteLLM request count or journal entries).
8. **Trigger management.** Enable, disable and reconcile. Test the semantics of records enqueued before a disable.
9. **Observability.** Correlate run ID, invocation ID, workflow and version, step and `traceId` across Restate UI, otel, and Langfuse (overlay).
10. **Only then** extract repeated patterns into `packages/runtime`, and write the README and `docs/decisions.md`.

## Execution patterns the abstractions must not block (not built in v1)

Each maps to a Restate primitive, with no DSL on top:

- **Sequential**: `await` in order.
- **Parallel and fan-out**: `RestatePromise.all` over service calls.
- **Async child**: `ctx.serviceSendClient` / `workflowSendClient`.
- **Long-running**: `ctx.sleep` and durable retries.
- **Human approval**: awakeables or a workflow `ctx.promise`.
- **Agent**: LLM → tool services → LLM, each call durable.
- **RAG** (v2): `RagIngestionWorkflow` → OCR / Chunk / Embedding / VectorStore services.

## Dev tooling (step 0; each item verified to exist, be maintained and use this install form)

**`.claude/settings.json`** (committed; the plugins activate after a session restart once the project is trusted):

```json
{
  "extraKnownMarketplaces": {
    "restatedev-plugin": { "source": { "source": "github", "repo": "restatedev/skills" } }
  },
  "enabledPlugins": {
    "restatedev@restatedev-plugin": true,
    "typescript-lsp@claude-plugins-official": true
  }
}
```

- `restatedev` is Restate's official plugin. It bundles the `building-restate-services` skill (SDK rules, determinism, replay tests) and the `restate-docs` MCP server.
- `typescript-lsp` needs `npm i -g typescript-language-server typescript` once.

**`.mcp.json`** (committed):

```json
{
  "mcpServers": {
    "mastra": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mastra/mcp-docs-server@1.2.27"]
    },
    "langfuse-docs": { "type": "http", "url": "https://langfuse.com/api/mcp" },
    "kafka": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@confluentinc/mcp-confluent@1.5.0", "--config", "./.claude/kafka-mcp.yaml"],
      "env": { "DO_NOT_TRACK": "true" }
    }
  }
}
```

- The Mastra docs server stays for the v2 agent/RAG work.
- `.claude/kafka-mcp.yaml` holds `connections: { local: { type: direct, kafka: { bootstrap_servers: "localhost:29092" } } }`.

**Skills** (project scope, recorded in `skills-lock.json`):

```
npx skills add vercel/turborepo --skill turborepo -a claude-code -y
npx skills add mcollina/skills --skill fastify-best-practices -a claude-code -y
npx skills add antfu/skills --skill pnpm --skill vitest -a claude-code -y
npx skills add docker/skills --skill docker-compose-patterns -a claude-code -y
npx skills add langfuse/skills --skill langfuse -a claude-code -y
npx skills add mastra-ai/skills --skill mastra -a claude-code -y      # for v2 agent/RAG work
```

- Already available: `supabase-postgres-best-practices` and context7.
- LiteLLM has no docs MCP; use `https://docs.litellm.ai/llms-full.txt`.

## Verification

- `pnpm check` (turbo build, typecheck and vitest unit tests) passes. Unit tests cover:
  - the metadata schema;
  - contract → JSON Schema generation and the contract hash;
  - the version and artifact conflict rule;
  - run-ID derivation;
  - the trigger adapter;
  - the subscription reconcile diff;
  - SQL quoting, keyset cursors and status mapping;
  - routes via `app.inject()` with stubbed Restate clients.
- `pnpm test:e2e` runs the vitest suites in `tests/e2e` against `docker compose up -d` plus `pipeline deploy summary content-enrichment`, with host Ollama serving `qwen3.5:4b`. It covers implementation steps 1–8:
  - **Catalogue**: lists `content-enrichment` (workflow, 2 triggers, active subscription, depends on `summary`) and `summary` (private service).
  - **REST**: a run completes with `{ summary, metadata }`. The same `Idempotency-Key` returns `PreviouslyAccepted` with the same run ID.
  - **Kafka**: an event published with `kafka-console-producer.sh` produces a `kf_…` run. Its `RunView.trigger` shows `kafka`, the topic, partition and offset.
  - **Private service**: direct ingress to `SummaryService` is rejected.
  - **Versioning**: v1 and v2 of the sleeper drain correctly, and retire is refused while v1 has in-flight runs.
  - **Crash**: killing the container mid-run still completes, and the LLM call is not repeated after it was journaled.
  - **Trigger disable**: the subscription is removed; `observedStatus` goes from `disabling` to `disabled`, and enqueued records are documented as still running.
- **Manual checks**:
  - the Restate UI (`http://127.0.0.1:9070`) shows the journals and the call from `ContentEnrichment` to `SummaryService`;
  - with the overlay, Langfuse (`http://127.0.0.1:3001`) shows the LiteLLM generation with tokens and cost.
