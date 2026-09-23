# AI Pipeline on Restate

A Restate-native AI pipeline platform.

- **Restate** is the durable runtime and the run store.
- **Kafka and REST** start workflows.
- A **Postgres catalogue**, fed by each unit's `metadata.json`, is the control plane.
- Each **workflow or service** is an independently deployable container.
- LLM calls go through **LiteLLM**, which routes to host Ollama.

The shipped example is `content-enrichment`. It is triggered by REST or by Kafka `content.published`, makes a durable call to the private `summary` service, and returns `{ summary, metadata }`.

```
REST ──► core-api ──(restate-sdk-clients)──┐
                                           ▼
Kafka ──(Restate subscription)──► ContentEnrichmentTrigger ──► ContentEnrichment ──► SummaryService (private)
                                                                  workflow              └ ctx.run → LiteLLM → Ollama
core-api (control plane) ──► Restate admin: deployments · subscriptions · SQL introspection
                         ──► Postgres catalogue: definitions · deployments · dependencies · triggers
```

The design is in [docs/plan.md](docs/plan.md). Settled decisions and lessons learned are in [docs/decisions.md](docs/decisions.md).

## Layout

| Path                               | What it holds                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/contracts`               | zod schemas (`./<unit>`) and `restate.iface` bindings (`./<unit>/api`), per unit    |
| `packages/api-contract`            | the HTTP surface: request/response schemas, the error envelope and its code union   |
| `packages/metadata`                | the `metadata.json` schema (`./metadata`), Restate naming (`./naming`), `./run-ids` |
| `packages/runtime`                 | small helpers: `./retry`, `./options`, `./kafka-trigger`, `./config`, `./serve`     |
| `packages/ai`                      | `Generate` over LiteLLM (AI SDK); providers stay behind it                          |
| `packages/observability`           | pino logger and optional OTel SDK                                                   |
| `packages/typescript-config`       | the shared `tsc` presets every package extends                                      |
| `packages/eslint-config`           | the shared lint rules, including the handler determinism checks                     |
| `services/summary`                 | `SummaryService`, private; one durable LLM step                                     |
| `workflows/content-enrichment`     | `ContentEnrichment` workflow, its Kafka trigger service and adapter                 |
| `apps/core-api`                    | Fastify: HTTP (`routes/`, `plugins/`) over rules (`domain/`) over stores (`store/`) |
| `apps/cli`                         | `pnpm pipeline …`: `commands/` over a typed API client and a Docker port            |
| `tests/fixtures/versioned-sleeper` | test-only workflow used for the versioning e2e                                      |
| `tests/e2e`                        | end-to-end suites against the compose stack                                         |

Packages export one entry point per purpose rather than a barrel `index.ts`, so a consumer pulls in
what it uses and no more — the deploy CLI reads contracts without loading the Restate SDK, and a
service that has no Kafka trigger never loads `kafkaTrigger()`. `turbo boundaries` enforces the
direction of the graph: contracts depend on nothing above them, and nothing depends on an app.

## Set up

You need Docker, Node 22.13 or newer, pnpm 11 (`corepack enable`), and a host Ollama serving `qwen3.5:4b` (`ollama pull qwen3.5:4b`).

```sh
cp .env.example .env
pnpm install && pnpm build
docker compose up -d --build            # postgres, kafka, restate, litellm, otel, core-api
pnpm pipeline deploy summary            # dependencies first
pnpm pipeline deploy content-enrichment
```

All ports bind to `127.0.0.1` only:

| Service                  | Address  |
| ------------------------ | -------- |
| core-api                 | `:3000`  |
| Restate admin API and UI | `:9070`  |
| LiteLLM                  | `:4000`  |
| Kafka (host listener)    | `:29092` |
| Postgres                 | `:5432`  |
| OTLP                     | `:4318`  |

The Restate ingress (8080) stays internal; REST requests go through core-api.

## Use it

```sh
# REST: start a run (Idempotency-Key makes it idempotent), then read it
curl -s localhost:3000/v1/workflows/content-enrichment/runs -H 'content-type: application/json' \
  -H 'idempotency-key: demo-1' -d '{"input":{"contentId":"c-1","text":"…"}}'
pnpm pipeline run content-enrichment <runId>

# Kafka: publish a content.published event (the adapter maps it to the workflow input)
echo '{"identifier":"do_1","objectType":"Content","edata":{"title":"T","body":"…"}}' | \
  docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic content.published
pnpm pipeline runs content-enrichment
```

### Core API

| Area          | Route                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Workflows     | `POST /v1/workflows/:name/runs` `{ input }` with optional `Idempotency-Key` → 202 `{ runId, invocationId, status }`        |
| Runs          | `GET /v1/runs?workflow=&status=&limit=&cursor=`                                                                            |
| Runs          | `GET /v1/runs/:workflow/:runId` (returns `output` once completed)                                                          |
| Runs          | `POST /v1/runs/:workflow/:runId/cancel`                                                                                    |
| Catalogue     | `GET /v1/workflows?kind=`                                                                                                  |
| Catalogue     | `GET /v1/workflows/:name` (schemas, config, triggers with desired and observed state, dependencies, versions, deployments) |
| Catalogue     | `PATCH /v1/workflows/:name/triggers/:id` `{ enabled }`                                                                     |
| Control plane | `POST /v1/deployments` (used by the CLI)                                                                                   |
| Control plane | `GET /v1/deployments?name=` (includes in-flight counts)                                                                    |
| Control plane | `DELETE /v1/deployments/:id` (retire; refused until drained)                                                               |
| Health        | `GET /health/live`, `GET /health/ready`                                                                                    |

- Run statuses are `running`, `completed`, `failed`, `cancelled` and `paused`.
- A `RunView` carries `runId`, `invocationId`, `workflowVersion`, `deploymentId`, `trigger` and `traceId`.
- Errors come back as `{ "error": { "code", "message" } }`.
- Run history is Restate's retention: 7 days for workflows and journals. It is operational history, not an audit log.

### CLI

```
pnpm pipeline deploy <name...> [--dev]     build (skipped when unchanged), start, register
pnpm pipeline deployments [name]           deployments with in-flight counts
pnpm pipeline retire <deploymentId>        retire a drained deployment and stop its container
pnpm pipeline workflows | start <wf> --input '{…}' [--key k] | runs [wf] | run <wf> <id> | cancel <wf> <id>
```

## Add a workflow or service

1. **Define the contract** in `packages/contracts`: zod input, output and config schemas, plus `restate.iface.workflow(...)` (or `.service(...)`). Register it in `registry.ts`.
2. **Create the unit.** Add `workflows/<name>/` (or `services/<name>/`) containing:
   - a `metadata.json` with `kind`, `name`, `restateName`, `version`, `config`, `triggers` and `dependencies`;
   - `src/index.ts`, where `restate.implement(contract, { handlers, options: workflowOptions(metadata) })` builds the handlers;
   - `src/main.ts` containing `serve(name, [definition, ...])`.
3. **Declare triggers** in `metadata.json`:
   - A REST trigger is `{ "id": "api", "type": "rest" }`.
   - A Kafka trigger is `{ "id", "type": "kafka", "cluster": "local", "topic", "adapter"? }`. Pair it with `kafkaTrigger({ metadata, input, adapters })`.
   - An adapter is a pure `(event) => input | null`, where `null` skips the event.
4. **Deploy** with `pnpm pipeline deploy <name>`. Each later change is a new artifact: bump `version`, or iterate with `--dev`.

The handler rules (all I/O in `ctx.run`, deterministic code, `RestatePromise` combinators) are in [CLAUDE.md](CLAUDE.md).

## Deploy, version, retire

- **Deployments are immutable.** Every artifact gets its own container and endpoint (`<name>-<digest12>:9080`) and its own Restate deployment.
- New runs go to the newest deployment, and in-flight runs finish on the deployment they started on. The older deployment shows as `draining`.
- `pnpm pipeline retire <id>` is refused (`DEPLOYMENT_NOT_DRAINED`) while runs are still pinned to it.
- The same `version` from a different artifact or contract is refused (`VERSION_ARTIFACT_CONFLICT` / `VERSION_CONTRACT_CONFLICT`).
- `--dev` overwrites a single `<name>-dev` endpoint in place. It is for local iteration only.

## Observability

Tracing is collected in two ways:

- **Always on:** Restate server spans, SDK spans (per attempt and per `ctx.run`) and service spans go to the OTel collector.
- **With the Langfuse overlay:** the same traces, plus LiteLLM generations with token usage and cost, all in one trace per run.

To start the overlay:

```sh
docker compose -f compose.yaml -f compose.observability.yaml up -d   # Langfuse UI: http://127.0.0.1:3001
```

The overlay needs about 4 GB of extra memory. The `traceId` in a `RunView` is the Langfuse trace ID. The Restate UI at `:9070` shows each invocation's journal.

## Tests

| Command            | What it runs                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`       | one `turbo run`: build, typecheck (tests included), lint, unit tests, formatting — then `turbo boundaries`              |
| `pnpm test`        | unit tests only                                                                                                         |
| `pnpm test:replay` | always-replay Restate tests (Testcontainers; needs Docker)                                                              |
| `pnpm test:e2e`    | against the running stack, host Ollama included: catalogue, REST, Kafka, triggers, immutable versioning, crash recovery |

`pnpm check` is the gate. It fails on a formatting drift as readily as on a type error, because a
reformat changes a unit's artifact digest and therefore needs a version bump — so drift is a
deployment problem here, not a cosmetic one.

## Developing with Claude Code

- `.claude/settings.json` enables Restate's official plugin (the `building-restate-services` skill plus the `restate-docs` MCP server) and `typescript-lsp`.
  - Trust the project and restart the session to activate them.
  - `typescript-lsp` needs `npm i -g typescript-language-server typescript`.
- `.mcp.json` adds these MCP servers: the Mastra docs server, `langfuse-docs`, and `kafka` (Confluent's MCP server pointed at `localhost:29092`).
- Project skills (`skills-lock.json`): turborepo, fastify-best-practices, pnpm, vitest, docker-compose-patterns, langfuse, mastra.

## Operations notes

- Always pass `-f compose.yaml -f compose.observability.yaml` together while the overlay is running.
- `docker compose down -v` wipes both Postgres (the catalogue) and Restate (runs, deployments, subscriptions). Remove the runtime containers too: `docker ps -aq --filter label=ai-pipeline.name | xargs docker rm -f`.
- Kafka topics are created by the `kafka-init` job; auto-creation is off. Add new topics there.
- If a subscribed topic disappears (e.g. Kafka recreated without its volume), Restate's consumer stops. Toggle the trigger to recreate the subscription (`PATCH /v1/workflows/<wf>/triggers/<id>` with `{"enabled":false}` then `{"enabled":true}`). It resumes from its committed offsets.
