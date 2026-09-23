# AI Pipeline on Restate — working rules

**The framework must not reimplement Restate.**

- **Restate owns:** durability, execution, retries, invocation state, service-to-service calls, concurrency, and routing between deployments.
- **This repo owns:** contracts, trigger configuration and adapters, model adapters, catalogue metadata, the control plane, and the external APIs.

Use the Restate context directly (`ctx.run`, `ctx.client`, `ctx.sendClient`, `RestatePromise.all`, `ctx.date.now()`). Do not add wrappers such as `WorkflowCtx`/`ctx.child()` or a DSL on top of it.

## Vocabulary

- **Step**: a plain function run inside a handler. It lives in the owning package and is not catalogued.
- **Service**: a reusable capability with its own Restate invocation, e.g. `services/summary`. Usually `visibility: private`.
- **Workflow**: stateful orchestration with a unique run ID, e.g. `workflows/content-enrichment`.

## Rules for handler code

- All I/O goes inside `ctx.run(name, fn, retry.<profile>)`, using the profiles in `@ai-pipeline/runtime/retry`.
- Code outside `ctx.run` must be deterministic:
  - no `Date.now()`, `Math.random()`, `new Date()` or timers — use `ctx.date.now()`, `ctx.rand`, `ctx.sleep()`;
  - no native `Promise.all`/`race`/`allSettled`/`any` over durable work — use `RestatePromise`.
  - **Lint enforces this** in `services/*`, `workflows/*` and `packages/runtime` (`@ai-pipeline/eslint-config/handlers`).
- Throw `TerminalError` for non-retryable failures, such as bad input or a business rule.
- Record run context at the start of `run` with `ctx.set('trigger', …)` and `ctx.set('version', …)`. The runs API reads it.
- Any handler logic change needs the always-replay test (`pnpm test:replay`) to pass.

## Contracts and metadata

- **A unit owns its contract.** `src/contract.ts` exports a `ContractEntry`, which the deploy CLI reads
  from `dist/contract.js`. There is no shared registry, and adding one would be a regression: the
  artifact digest covers a unit's workspace dependencies, so a file every unit imports means adding
  one workflow changes every other unit's artifact and forces a round of version bumps.
- `packages/contract-<name>` exists only for a contract a **second** unit needs (a caller needs its
  callee's contract). `packages/contracts` is the shared kit: the trigger envelope, the JSON Schema
  generation, the `ContractEntry` type. Nothing unit-specific belongs in it.
- Split every contract into schemas (zod) and api (`restate.iface`), so the catalogue side of a
  contract does not drag the Restate SDK into tools that only read schemas.
- A workflow's entry handler **must** be named `run` — the runs API selects invocations by that name.
  `pipeline deploy` enforces it.
- Types and schemas are zod; never hand-write JSON Schema.
- `metadata.json` is operational metadata only: kind, restateName, version, config, triggers and dependencies.
- **Any change to a unit or its workspace dependencies is a new artifact.** Bump the unit's `version` to deploy it immutably, or iterate with `pnpm pipeline deploy <unit> --dev`.
  - Otherwise the control plane answers `VERSION_ARTIFACT_CONFLICT`.
  - Reformatting counts as a change.

## Conventions

- TypeScript strict ESM (NodeNext): `./x.js` imports and `node:` built-ins.
- zod for config and contracts; Prettier (single quotes, width 100).
- **No barrel files.** A package declares one export per purpose (`@ai-pipeline/runtime/retry`), each
  with an `@ai-pipeline/source` condition naming its source — which is also what `vitest.config.ts`
  builds its aliases from. Adding a module means adding an export, not widening an `index.ts`.
- **Layering.** `apps/core-api` is HTTP (`routes/`, `plugins/`) over rules (`domain/`) over stores
  (`store/`) and adapters (`restate/`); `views.ts` owns every row→wire mapping. `domain/` takes its
  collaborators as interfaces (`ControlPlane`), so rules are testable without Fastify or Postgres.
  Keep SQL in `store/`, Restate calls in `restate/`, and neither in a route.
- **`turbo boundaries` enforces the package graph** via tags in each package's `turbo.json`:
  `contract` → nothing above it, `runtime` → no units or apps, `unit` → no apps, and nothing depends
  on an app. A dependency a package does not declare is an error, not a hoisting accident.
- Errors on the wire use the envelope `{ error: { code, message } }`. The codes are a shared union in
  `@ai-pipeline/api-contract/errors` — add one there, and both the server and the CLI see it.
- Dependency versions used by more than one package live in the `catalog:` in `pnpm-workspace.yaml`.
- Tests:
  - unit tests sit next to the code (`src/**/*.test.ts`); shared fakes go in `src/testing/`, which
    neither ships nor counts toward the artifact digest;
  - replay tests are `*.replay.test.ts` (Testcontainers);
  - e2e tests are in `tests/e2e` and use the types from `@ai-pipeline/api-contract`.

## Adding a unit

`pnpm pipeline new <workflow|service> <name> [--kafka <topic>]`. It generates a unit that builds,
lints and deploys as it stands, with the conventions already applied. Do not hand-roll one: the files
have to agree with each other, and the failure mode is a deploy-time error.

## The catalogue schema

Created when Postgres is provisioned (`infra/postgres/init/`), never by the API. The service assumes
the tables exist and issues no DDL. Add a table by adding to that SQL, not by writing migration code.

## Commands

`pnpm check` · `pnpm test:replay` · `pnpm test:e2e` · `pnpm pipeline …` · see README.md.

`pnpm check` is one `turbo run` (build, typecheck, lint, unit tests, format) plus `turbo boundaries`.
Root `package.json` only delegates to turbo; task logic belongs in each package.

## Tooling

- The Restate plugin supplies the `building-restate-services` skill and the `restate-docs` MCP server (`.claude/settings.json`).
- Other MCP servers in `.mcp.json`: the Mastra docs server, `langfuse-docs`, and `kafka` (topics, consumer lag, publishing test events).
