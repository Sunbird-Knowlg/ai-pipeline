# AI Pipeline — Folder-by-Folder Guide for a TypeScript Newcomer

## Summary

This document explains every top-level folder and file in this repo, what it
contains, and what it's for — written for someone who has never used
TypeScript. It does not assume you've read any other doc first. Where a
TypeScript-specific term shows up, it's explained inline the first time.

## 0. What this project actually does, in one paragraph

This repo is a small platform for running AI-powered "workflows" — multi-step
processes like "take a piece of content, summarize it, extract metadata,
generate a quiz" — in a way that survives crashes and restarts without losing
progress. The actual crash-survival machinery (retries, resuming, tracking
state) is handled by a separate piece of infrastructure called **Restate**,
which this repo runs as one of its Docker containers. This repo's own job is
everything Restate doesn't do: defining what each workflow/service actually
does, exposing them over REST and Kafka, calling an LLM (through a proxy
called LiteLLM, pointed at a local Ollama model), and keeping a small database
(Postgres) that tracks what's deployed. Two example workflows ship in the
repo, `content-enrichment` (minimal) and `content-authoring` (fuller,
reference example) — see section 6.

## 1. TypeScript, in the amount you need to read this repo

You don't need to write TypeScript to understand this repo's shape. You do
need to recognize a few things when you see them in file listings below:

| You'll see | It means |
|---|---|
| `.ts` file | Source code, written in TypeScript (a superset of JavaScript with type annotations) |
| `.test.ts` file | A test file, sitting right next to the code it tests |
| `.replay.test.ts` | A special test that checks a workflow behaves correctly when Restate replays its history (see section 6) |
| `package.json` | Node.js's project file: name, dependencies, scripts. One per package/app/unit — this is a "monorepo" (many packages in one repo) |
| `tsconfig.json` / `tsconfig.build.json` | Compiler settings: how strictly to type-check, what to compile | 
| `turbo.json` | Config for Turborepo, the tool that runs build/test/lint across all packages efficiently and caches results |
| `eslint.config.js` | Linting rules — automated code-style and correctness checks that run as part of `pnpm check` |
| `dist/` (not checked in) | Compiled JavaScript output, produced by building a `.ts` source folder |
| `node_modules/` (not checked in) | Downloaded dependencies, managed by `pnpm` |

Two words used constantly in this repo, defined once:

- **Unit** = a workflow or a service (see section 6) — anything independently
  deployable, each living in its own folder with its own `package.json`.
- **Contract** = a unit's declared input/output/config shapes, checked by a
  library called `zod` (explained in section 6.1) — this is how one unit
  knows what shape of data another unit expects, without needing to read its
  source.

## 2. Top-level layout

```
ai-pipeline/
├── apps/            two runnable programs: the HTTP API and the CLI
├── packages/        shared library code, reused by apps/services/workflows
├── services/        small reusable capabilities (see section 6)
├── workflows/       the actual orchestrated processes (see section 6)
├── infra/           config for supporting Docker containers (Postgres, LiteLLM, OTel)
├── tests/           end-to-end tests and one test-only fixture workflow
├── docs/            design notes, decisions, QA report, example walkthrough
├── manifests/       a Postman collection used as a live API reference
├── .claude/         Claude Code settings for this repo (skills, plugins)
├── compose.yaml, compose.observability.yaml    Docker Compose files
├── CLAUDE.md        the working rules AI assistants (and humans) follow here
├── README.md        setup instructions and command reference
└── package.json, pnpm-workspace.yaml, turbo.json, tsconfig.json, vitest.config.ts
    root-level config that ties the whole monorepo together
```

## 3. `apps/` — the two runnable programs

### 3.1 `apps/core-api` — the HTTP control plane

This is a web server (built with a framework called **Fastify**, the Node.js
equivalent of Flask/Express) that is the front door to the whole system: it
receives REST requests, talks to Restate, and reads/writes the Postgres
catalogue. It's organized in four layers, and the project's rule is strict
about which layer does what:

| Folder | Layer | Job | Rule |
|---|---|---|---|
| `src/routes/` | HTTP | Parses requests, calls into `domain/`, shapes responses | No SQL, no direct Restate calls here |
| `src/domain/` | Business rules | Decides *what* should happen (register a deployment, reconcile triggers, cancel a run) | Takes its dependencies (`ControlPlane`, an interface) as parameters, so it's testable without a real Fastify server or real Postgres |
| `src/store/` | Database | All the SQL, talking to the Postgres catalogue | SQL lives only here |
| `src/restate/` | Restate adapter | Calls to Restate's own admin API and ingress | Restate calls live only here |
| `src/plugins/` | Fastify wiring | Cross-cutting concerns: error formatting, security headers, dependency injection into routes | — |
| `src/views.ts` | Mapping | Converts database rows into the JSON shapes the API actually returns | The one place row→wire conversion happens |

Concretely, one file per concept:

- `src/app.ts` — builds the Fastify instance, registers the plugins and route
  groups. This is the "wiring" file — read it first to see how the pieces fit.
- `src/main.ts` — the actual process entry point (creates real DB/Restate
  connections and starts listening).
- `src/domain/registration.ts` — handles a new deployment being registered.
- `src/domain/reconcile.ts` — makes sure Restate's actual Kafka subscriptions
  match what each unit's `metadata.json` declares.
- `src/domain/runs.ts` — start/read/cancel/kill/resume a run.
- `src/domain/triggers.ts` — enable/disable a trigger.
- `src/domain/retirement.ts` — retire a drained deployment.
- `src/domain/catalogue.ts` — read the catalogue (list/describe workflows).
- `src/store/db.ts`, `store/store.ts`, `store/definitions.ts`,
  `store/dependencies.ts`, `store/deployments.ts`, `store/triggers.ts` — the
  actual Postgres queries, one file per catalogue concept.
- `src/restate/admin.ts` — calls Restate's admin API (register/list/delete
  deployments).
- `src/restate/ingress.ts` — calls Restate's ingress (starts/reads/cancels
  runs).
- `src/restate/invocations.ts` — reads invocation details from Restate.
- `src/json-schema.ts` — converts zod schemas (from a unit's contract) into
  JSON Schema, for the catalogue API to expose.
- `src/errors.ts` — the error envelope used on the wire.
- `src/testing/` — shared fakes (in-memory store, fake Restate) used across
  tests. This folder is excluded from what actually ships.

### 3.2 `apps/cli` — the `pnpm pipeline …` tool

A command-line tool developers run locally. Key files:

- `src/main.ts` — the CLI's entry point, wires up the subcommands.
- `src/commands/deploy.ts` — builds a unit (if changed), starts its container,
  registers it with the running core-api.
- `src/commands/scaffold.ts` — implements `pipeline new <workflow|service> <name>`,
  which generates a whole new unit's files from a template.
- `src/commands/deployments.ts`, `src/commands/runs.ts` — list deployments,
  start/read/cancel runs from the command line.
- `src/units.ts` — logic for discovering units in the monorepo and reading
  their `metadata.json`/contract.
- `src/artifact.ts` — computes the artifact digest (a hash) used to detect
  whether a unit's code actually changed since its last deploy — this is what
  powers the "any change is a new artifact" rule from `CLAUDE.md`.
- `src/docker.ts` — builds/runs/stops the unit's container.
- `src/core-api.ts` — a typed HTTP client for talking to `apps/core-api`.
- `src/workspace.ts`, `src/manifest.ts`, `src/env.ts` — monorepo/workspace file
  discovery, package manifest reading, environment loading.

## 4. `packages/` — shared library code

Each folder here is a separate installable package (its own `package.json`,
name like `@ai-pipeline/runtime`), imported by apps/services/workflows. None
of these are runnable on their own.

| Package | What it's for |
|---|---|
| `packages/contracts` | The shared contract *kit*: `entry.ts` defines the `ContractEntry` shape every unit's contract must match; `trigger.ts` defines the "run request" envelope wrapping a workflow's input; `schemas.ts` has shared building-block schemas |
| `packages/contract-summary`, `contract-content-metadata`, `contract-quiz-generate` | One package per *service* that a second unit needs to call — each holds that service's input/output/config zod schemas and its `restate.iface` API binding, split apart so a caller can depend on just the schemas |
| `packages/api-contract` | The HTTP-facing contract: request/response schemas for `apps/core-api`'s own routes, the `{ error: { code, message } }` envelope, and the shared error-code union |
| `packages/metadata` | Reads and validates `metadata.json` (`metadata.ts`), Restate naming conventions (`naming.ts`), and run ID generation (`run-ids.ts`) |
| `packages/runtime` | Small helpers every handler uses: `retry.ts` (named retry profiles — see section 4.1), `options.ts` (Restate service/workflow option builders), `kafka-trigger.ts` (turns a `metadata.json` Kafka trigger + an adapter into a runnable trigger service), `config.ts` (loads and validates a unit's config against its contract), `serve.ts` (starts the Restate HTTP endpoint for a unit) |
| `packages/ai` | Wraps LiteLLM behind one function, `generate` (`generate.ts`), plus `errors.ts` which distinguishes retryable model errors from terminal ones |
| `packages/observability` | `logger.ts` (a pino-based logger, with a custom error serializer — see section 8), `telemetry.ts` (OpenTelemetry setup) |
| `packages/eslint-config` | Two shared lint configs: `base.js` (general rules) and `handlers.js` (the determinism rules described in section 6 — no `Date.now()`, no native `Promise.all`, etc., enforced only inside `services/*`, `workflows/*`, `packages/runtime`) |
| `packages/typescript-config` | Shared `tsconfig` presets (`base.json`, `app.json`, `library.json`) every package extends, so compiler strictness is defined once |

### 4.1 A closer look: `packages/runtime/src/retry.ts`

```ts
export const retry = {
  llm: { initialRetryInterval: { seconds: 2 }, maxRetryInterval: { seconds: 60 } },
  http: { maxRetryAttempts: 5, initialRetryInterval: { milliseconds: 500 }, maxRetryInterval: { seconds: 10 } },
  db: { maxRetryAttempts: 3, initialRetryInterval: { milliseconds: 100 }, maxRetryInterval: { seconds: 1 } },
} satisfies Record<string, RunOptions<unknown>>;
```

This is a plain object with three named presets, passed as the third argument
to `ctx.run(name, fn, retry.llm)` (see section 6). `llm` has **no**
`maxRetryAttempts` — deliberately uncapped, because an LLM gateway outage
should pause the run (so it can resume once the gateway is back) rather than
fail it outright. `http` and `db` are capped, because a plain API or database
call that keeps failing after 5 or 3 tries is treated as a real failure, not
something to wait out indefinitely. (`satisfies Record<string, RunOptions<unknown>>`
is a TypeScript-only line — it checks each preset matches Restate's expected
shape, without changing the object's actual type. You can ignore the syntax;
what matters is "each of these three names is a config object Restate
understands.")

## 5. `services/` and `workflows/` — the deployable units

Every folder under these two directories is one **unit** (see section 1), and
every unit has the same internal shape:

| File | Purpose |
|---|---|
| `metadata.json` | Identity card: kind, name, Restate name, version, config values, triggers, dependencies |
| `src/contract.ts` | Exports the `ContractEntry` the deploy CLI reads |
| `src/schemas.ts` | zod input/output/config shapes (workflows only put these here directly; services with a second caller put them in a `packages/contract-*` package instead) |
| `src/api.ts` | The `restate.iface` binding — the Restate-SDK-specific half of the contract |
| `src/unit.ts` | Loads `metadata.json` and validates its `config` against the contract, once, at startup |
| `src/service.ts` / `src/workflow.ts` | The actual handler code |
| `src/main.ts` | The process entry point that starts the Restate HTTP endpoint for this unit |
| `src/trigger.ts`, `src/adapters.ts` | Present only if the unit has a Kafka trigger — the trigger service and its record-to-input mapping |

### 5.1 `services/summary` (existing, minimal)

One durable LLM call: summarize text. `visibility: private` in its
`metadata.json` — meaning only other units call it, it has no REST trigger of
its own.

### 5.2 `services/content-metadata` and `services/quiz-generate` (new)

Two more private services, added alongside `content-authoring`. Same shape as
`summary`: one `service.ts` handler wrapping an LLM call, its own `prompt.ts`
(the actual prompt text sent to the model) and `prompt.test.ts`. Their
contracts live in `packages/contract-content-metadata` and
`packages/contract-quiz-generate` because `content-authoring` (a second unit)
needs to call them.

### 5.3 `workflows/content-enrichment` (existing, minimal reference)

REST or Kafka (`content.published`) in, one call to `summary`, a summary +
basic text stats out. Deliberately the *simplest possible* correct example.

### 5.4 `workflows/content-authoring` (new, fuller reference)

The newest addition. REST or Kafka (`diksha.content.published`) in; calls
three shared services (`summary`, `content-metadata`, `quiz-generate` — two of
them in parallel via `RestatePromise.all`, the third afterward because it
needs their answers); returns a summary + extracted metadata + a quiz. Its
adapter (`src/adapters.ts`) has a deliberate rule: a `Collection` or a `Draft`
item is silently skipped (not every message on that Kafka topic is meant for
this workflow), but a `Live` content item with no text is a hard failure. It's
annotated end-to-end in `docs/example-workflow.md` — read that file if you're
about to write a new workflow, since `CLAUDE.md` names it as the canonical
reference.

### 5.5 `tests/fixtures/versioned-sleeper`

A tiny test-only workflow that exists purely so the versioning/e2e tests have
something disposable to deploy multiple versions of. Not a real example to
learn from.

## 6. What a handler actually looks like, and why (Restate concepts)

Restate is the piece of infrastructure that makes all of this crash-safe. It
runs as its own Docker container (see `compose.yaml`) and this repo's code
talks to it through an object called `ctx`, passed into every handler.

The core idea: every "step" a handler takes is recorded in a durable journal.
If the process crashes and restarts, Restate replays the journal — a step
that already finished returns its *recorded* result instantly instead of
re-running. This is why the project has a hard rule (`CLAUDE.md`, enforced by
`packages/eslint-config/handlers.js`): **all I/O goes inside
`ctx.run(name, fn, retry.<profile>)`**, and everything *outside* of that must
be deterministic — no `Date.now()`, `Math.random()`, `new Date()`, timers, or
native `Promise.all`/`race`/`allSettled`/`any` over durable work. Use
`ctx.date.now()`, `ctx.rand`, `ctx.sleep()`, and `RestatePromise.all` instead
— these are Restate's own replay-safe equivalents.

| Restate API | Used for |
|---|---|
| `ctx.run(name, fn, retryProfile)` | Any I/O: an LLM call, an HTTP call, a DB write. Journaled — replayed, not re-executed |
| `ctx.client(api).method(args)` | A durable call to another service/workflow |
| `ctx.date.now()` | The current time, replay-safe |
| `RestatePromise.all([...])` | Wait on multiple durable calls concurrently, replay-safe |
| `ctx.set('key', value)` | Record state on this run, readable later by the runs API |
| `restate.TerminalError` | Thrown for a failure that retrying will never fix (bad input, business rule) — tells Restate "stop retrying, fail the run" |

The project's rule against building a custom `WorkflowCtx` or DSL on top of
`ctx` is explicit: **the framework must not reimplement Restate.** Handler code
calls Restate's own APIs directly, the way Restate's own documentation
teaches it, with no extra layer in between.

## 7. `infra/` — supporting containers' configuration

- `infra/postgres/init/` — SQL run **once**, automatically, the first time the
  Postgres container starts against an empty data directory (`10-databases.sql`
  creates the databases, `20-catalogue.sql` creates the catalogue tables). The
  API itself never creates or alters tables — this is the only place schema
  changes happen. If you already have a Postgres volume from a previous run,
  editing these files and restarting does nothing until you either apply the
  SQL manually or wipe the volume (`docker compose down -v`).
- `infra/litellm/` — LiteLLM's own config: `config.yaml` (routes model names
  like `chat-default` to the local Ollama server) and `config.langfuse.yaml`
  (an overlay used when the observability stack is running).
- `infra/otel/` — OpenTelemetry Collector config: `config.yaml` is the base
  (logs spans, stores nothing), `langfuse.yaml` is the overlay that exports
  traces to Langfuse.

## 8. `docs/` — the non-code documentation already in this repo

| File | Contents |
|---|---|
| `docs/plan.md` | The original design |
| `docs/decisions.md` | Settled decisions and lessons learned as the project evolved |
| `docs/example-workflow.md` | A decision-by-decision walkthrough of `workflows/content-authoring` — the canonical "how to write a workflow" reference |
| `docs/qa-report.md` | The 18 findings from a QA pass done alongside adding `content-authoring` — includes real bugs like a Kafka consumer heartbeat/eviction issue, a logger leaking secrets (full error object, including a model prompt and an Authorization header, was being logged), a connection-pool deadlock in a locking helper, and a regex-denial-of-service risk in schema validation, each with evidence and the fix |
| `docs/review-brief.md` | A brief written for an external reviewing agent |

## 9. `tests/` and `manifests/`

- `tests/e2e/` — end-to-end tests that run against the whole live stack
  (Docker Compose up): catalogue behavior, REST and Kafka triggers, immutable
  versioning, crash recovery. `content-authoring.test.ts` is the e2e suite for
  the new reference workflow.
- `tests/fixtures/versioned-sleeper` — see section 5.5.
- `manifests/ai-pipeline.postman_collection.json` +
  `local.postman_environment.json` — a Postman collection covering every
  route with assertions; doubles as a human-readable API reference, and a test
  fails the build if a route exists without a matching Postman request (or
  vice versa), so it can't go stale.

## 10. Root-level files

| File | Purpose |
|---|---|
| `package.json` | Root manifest; only delegates to Turborepo — no real task logic lives here |
| `pnpm-workspace.yaml` | Declares which folders are workspace packages, and the shared dependency-version `catalog:` |
| `pnpm-lock.yaml` | The exact, locked dependency tree — never hand-edit |
| `turbo.json` | Defines the build/lint/test task graph and caching rules across every package |
| `tsconfig.json` | Root TypeScript config, extended by each package's own |
| `vitest.config.ts` | Test runner config; builds its module aliases from each package's declared export conditions |
| `eslint.config.js` | Root lint config, pulling in `packages/eslint-config` |
| `.env.example` | Template for local environment variables — copy to `.env` |
| `compose.yaml` | The core Docker stack: postgres, kafka, restate, litellm, otel, core-api |
| `compose.observability.yaml` | An add-on stack (Langfuse) layered on top for tracing with cost/latency data |
| `Dockerfile`, `.dockerignore` | Container build definition for the units/apps |
| `.nvmrc` | Pins the Node.js version |
| `.prettierrc.json`, `.prettierignore` | Code formatting rules (single quotes, 100-char width) |
| `CLAUDE.md` | The working rules this repo's contributors (and AI assistants) follow |
| `README.md` | Setup steps and the full command/API reference |
| `skills-lock.json` | Pins which Claude Code project skills are in use |
| `.claude/`, `.mcp.json` | Claude Code configuration for this repo: enabled skills, MCP servers (Restate docs, Mastra docs, Langfuse docs, Kafka) |

## 11. Try it yourself

```sh
pnpm pipeline deploy summary                 # dependency first
pnpm pipeline deploy content-enrichment
curl -s localhost:3000/v1/workflows/content-enrichment/runs \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"input":{"contentId":"c-1","text":"some text to summarize"}}'
pnpm pipeline run content-enrichment <runId>   # read the result
```

For the fuller example:

```sh
pnpm pipeline deploy summary content-metadata quiz-generate   # dependencies first
pnpm pipeline deploy content-authoring
```

## 12. Where to read next

- `docs/example-workflow.md` — the annotated walkthrough of the reference
  workflow, decision by decision.
- `CLAUDE.md` — the enforced rules (determinism, contracts, versioning).
- `README.md` — full setup and API command reference.
