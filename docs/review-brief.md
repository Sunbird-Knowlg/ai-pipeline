# Review brief: deep review and adversarial testing of the AI pipeline

> Hand this file to the reviewing agent as its prompt. It is self-contained: it states what the
> system is, what "correct" means, where the risk is concentrated, and what evidence a finding needs.

---

## Your role

You are a principal engineer doing a **pre-production review** of an AI pipeline built on Restate.
You have full access to the repository and to a machine that can run the whole stack. Your job is to
find what is actually wrong, not to admire the structure.

Two things you are **not** here to do:

- **Not a style review.** Formatting, naming preferences, file-length opinions and "I'd have done it
  differently" are noise. Prettier and ESLint already run in CI-equivalent form.
- **Not a restatement of the docs.** `docs/decisions.md` and `CLAUDE.md` make claims about how this
  system behaves. Treat every one of them as a **hypothesis to falsify**, not as background reading.
  A doc that no longer matches the code is itself a finding.

You are here to do three things, in priority order:

1. **Find bugs** — behaviour that is wrong, unsafe under concurrency or failure, or that will break
   in production. Correctness, data integrity, durability, security.
2. **Find the gaps between what is claimed and what is enforced** — an invariant documented but not
   tested, a guardrail that does not actually guard, a test that would pass if the code were broken.
3. **Propose improvements** worth the change — ranked, with the cost stated. Include what you would
   do _before_ putting real traffic through this.

**Every finding must carry evidence.** A command and its output, a failing test you wrote, an HTTP
exchange, a log line, a `file:line`. "This looks risky" without a demonstrated consequence is not a
finding — either build the repro or file it explicitly as an unverified suspicion.

---

## What the system is

An AI pipeline where **Restate owns durable execution** and this repo owns everything around it.

```
REST ──► core-api ──(restate-sdk-clients)──┐
                                           ▼
Kafka ──(Restate subscription)──► ContentEnrichmentTrigger ──► ContentEnrichment ──► SummaryService
                                                                  (workflow)          (private)
                                                                                  └ ctx.run → LiteLLM → Ollama
core-api (control plane) ──► Restate admin API: deployments · subscriptions · introspection SQL
                         ──► Postgres catalogue: definitions · deployments · dependencies · triggers
```

The load-bearing design decisions:

- **Restate is the run store.** There is no run table. Runs are read out of Restate's
  `sys_invocation` and `state` tables over its admin SQL endpoint. Postgres holds only the catalogue.
- **Deployments are immutable.** One container per artifact at its own endpoint
  (`<name>-<digest12>:9080`), one Restate deployment each. In-flight invocations stay pinned to the
  deployment they started on. A deployment is retired only once drained.
- **An artifact is a source digest**, not a Docker image id: sha256 over the build recipe, the
  lockfile, and the sources of the unit and its workspace dependencies. A version binds to exactly
  one contract and one artifact; re-registering the same version from different bytes is a 409.
- **The control plane deploys; runtimes only serve handlers.** `pnpm pipeline deploy` builds the
  image, starts the container, then `POST /v1/deployments` — core-api registers it with Restate,
  writes the catalogue and reconciles Kafka subscriptions.
- **Contracts are zod**, in `packages/contracts`, split into schemas and `restate.iface` bindings.
  The deploy CLI turns them into draft-07 JSON Schema for the catalogue; core-api validates REST
  input against the catalogued schema of the version that will run.
- **No auth in v1.** Every port binds to `127.0.0.1`; a Host allow-list plus a cross-site check on
  unsafe methods are the only guards.

Layout, and where to expect what:

| Path                                            | Contains                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `apps/core-api/src/routes`, `plugins`           | HTTP: parsing, serialization, security, error envelope             |
| `apps/core-api/src/domain`                      | the rules — registration, retirement, runs, trigger reconciliation |
| `apps/core-api/src/store`                       | the only SQL; repositories per aggregate                           |
| `apps/core-api/src/restate`                     | admin + ingress adapters, invocation SQL                           |
| `apps/core-api/src/views.ts`                    | every internal-record → wire-view mapping                          |
| `apps/cli/src/commands`                         | `pnpm pipeline …`, over a typed API client and a `Docker` port     |
| `packages/contracts`, `packages/api-contract`   | the Restate contracts, and the HTTP contract                       |
| `packages/runtime`                              | retry profiles, service options, `kafkaTrigger()`, `serve()`       |
| `services/*`, `workflows/*`, `tests/fixtures/*` | deployable units                                                   |
| `tests/e2e`                                     | suites against the live stack                                      |

---

## Getting the code

The repository is **private**. Clone the `main` branch — that is the only branch, and its tip is the
state under review. You need to have been granted access first; if the clone 404s, that is an access
problem, not a wrong URL.

```sh
# with the GitHub CLI (uses your existing auth)
gh repo clone yravinderkumar33/ai-pipeline-restate -- --branch main
# or over HTTPS with a token that has `repo` scope
git clone --branch main https://github.com/yravinderkumar33/ai-pipeline-restate.git
# or over SSH, if your key is on the account
git clone --branch main git@github.com:yravinderkumar33/ai-pipeline-restate.git

cd ai-pipeline-restate
git log --oneline          # confirm your tip matches the commit you were asked to review
```

Work on a branch off `main` (`git switch -c review/<your-name>`) so the tree stays clean and anything
you write is easy to hand back as a patch. Do not push to `main`.

There is no prior history to diff against: `main` starts with the initial import, so there is no
"before" state and no pre-refactor baseline to compare behaviour to. Judge the code on its own terms
and against the invariants below.

## Getting it running

```sh
# Prerequisites: Docker, Node >= 22.13, pnpm 11 (corepack enable),
# and a host Ollama serving qwen3.5:4b (ollama pull qwen3.5:4b).
cp .env.example .env
pnpm install --frozen-lockfile
pnpm check                       # build, typecheck, lint, unit tests, format, turbo boundaries
pnpm test:replay                 # always-replay Restate tests (Testcontainers)

docker compose up -d --build     # postgres, kafka, restate, litellm, otel, core-api
pnpm pipeline deploy summary             # dependencies first
pnpm pipeline deploy content-enrichment
pnpm test:e2e                    # against the running stack
```

Ports (all `127.0.0.1`): core-api `:3000`, Restate admin + UI `:9070`, LiteLLM `:4000`, Kafka
`:29092`, Postgres `:5432`, OTLP `:4318`. The Restate ingress (8080) is deliberately internal.

**Judge results by exit code, not by grepping logs.** A previous reviewer of this codebase reported
a green gate that was in fact failing, because the grep pattern did not match the failure line.

---

## The invariants

These are what "correct" means here. Cite them by number in your findings. For each, decide: is it
true in the code? is it _tested_? would a test catch it being broken?

**Durability and determinism**

1. All I/O happens inside `ctx.run(...)`. Code outside it is deterministic across replays: no
   wall-clock, randomness, timers, iteration-order dependence, or native promise combinators over
   durable work.
2. A journaled step is executed exactly once, however many times the handler replays.
3. A run's recorded `trigger` and `version` come from the handler itself, so they survive replay and
   cannot be back-filled or forged by a caller.

**Immutability and versioning**

4. `name@version` binds to exactly one contract hash and, in immutable mode, one artifact digest.
   A conflicting registration is refused (409) and changes nothing.
5. The artifact digest changes if and only if the bytes that reach the image change. Test-only code
   (`*.test.ts`, `src/testing/**`) must not affect it; the build recipe, lockfile, shared compiler
   config, `metadata.json` and workspace-dependency sources must.
6. In-flight invocations finish on the deployment they started on. Retire is refused while anything
   is pinned, and refused for whatever Restate still routes to — even if the catalogue disagrees.
7. `active` mirrors Restate's routing rather than leading it. Re-registering an older endpoint does
   not move routing back to it, and does not resync its triggers.

**Control-plane safety**

8. Registration refuses everything it can refuse _before_ Restate is touched. After Restate has
   registered the endpoint, every remaining step is idempotent and failures are reported as retryable
   (503) rather than rolled back.
9. The deploy CLI removes a container only if this deploy started it _and_ the refusal was one of
   `PRE_REGISTRATION_CODES`. Removing a container Restate may already route to is a production outage.
10. Concurrent registrations of one unit, and concurrent trigger reconciles, are serialised.
    `POST /subscriptions` is not idempotent, so a lost race duplicates a consumer.

**The wire**

11. Every failure leaves as `{ error: { code, message } }`, with `code` from the shared union in
    `@ai-pipeline/api-contract/errors`.
12. Responses are serialized against JSON Schema generated from the contract. A field the contract
    does not declare is dropped. Therefore: **the contract must declare everything a route returns.**
13. No caller-supplied value reaches Restate's SQL endpoint unquoted or unvalidated. DataFusion takes
    no bind parameters.
14. Restate failures are distinguished: `RESTATE_UNAVAILABLE` (did not answer, retryable) vs
    `RESTATE_ADMIN_ERROR` (answered and refused).

**Boundaries**

15. `packages/runtime` stays small and adds no programming model over Restate: no `ctx` wrapper, no
    orchestration DSL, no re-implementation of retries, state or scheduling.
16. The package graph is acyclic and directional: contracts depend on nothing above them, runtime not
    on units or apps, units not on apps, and nothing depends on an app. core-api never imports a
    workflow's contract — it addresses workflows by Restate name.
17. **Units are independently deployable.** Adding, changing or removing one unit must not change
    another unit's artifact digest. A unit owns its contract; a `packages/contract-*` exists only for
    a contract a second unit needs. There is no shared registry of contracts.

---

## Where to look hardest

Ranked by expected value. Each is a **hypothesis** — some are confirmed defects, most are suspicions
that need a repro or a dismissal. Do not stop at this list; it is where to start, not the scope.

### 1. Response-schema stripping (invariant 12) — highest risk

Routes serialize through JSON Schema generated from `packages/api-contract`. Anything the schema omits
is silently removed from the response. This was introduced recently and is the single most likely
source of a regression that no unit test notices.

- For **every** route, compare the object the handler builds against what the client receives. Walk
  `apps/core-api/src/views.ts` and each `routes/*.ts` against the zod schemas.
- Pay attention to conditionally-present fields (`note`, `drainedAt`, `lastError`, `subscriptionId`,
  `activeDeployment`, `traceId`, `error`, `output`, `trigger`, `nextCursor`) and to anything typed as
  opaque JSON.
- Check the error and 503 paths too, not just 200s.
- `apps/core-api/src/routes/serialization.test.ts` pins some of this. Is it pinning _enough_?

### 2. Timestamps on the wire

`views.ts` converts Postgres `Date` to ISO strings by hand (`iso()`), and the contract types them as
`z.iso.datetime()`. Find any path where a `Date` reaches serialization without conversion, or where a
timestamp is emitted in a different shape than the contract claims. Note that run timestamps come
from Restate as strings and are passed through untouched — verify they are actually ISO-8601.

### 3. Concurrency — the tests do not cover it

`apps/core-api/src/testing/store.ts` is an in-memory `Store` whose `withLock` only records the key
and whose `transaction` provides no isolation. So the domain tests **assert that a lock was taken,
not that it works**. Invariant 10 is therefore untested.

Probe it for real, against Postgres and Restate:

- Two `pnpm pipeline deploy <unit>` in parallel. Two with different artifacts at the same version.
- Parallel `PATCH .../triggers/<id>` toggles. Does a duplicate subscription ever appear
  (`GET :9070/subscriptions`)? Does a consumer get orphaned?
- A deploy racing a retire of the same unit.
- Registration racing a Restate routing change.
- Is the advisory lock released on every path, including a thrown error inside a transaction?
  `withLock` uses a session-level lock on a dedicated connection — what happens if that connection
  drops mid-section?

### 4. Read-path cost — two N+1s were fixed; check the fixes hold

`GET /v1/workflows` used to fetch the global subscription list once per catalogued unit, and
`GET /v1/deployments` ran one in-flight query per deployment. Both now issue a single call, pinned by
`domain/catalogue.test.ts`.

Verify with a populated catalogue: how many Restate round trips does each read actually make? Look for
the same pattern elsewhere — anywhere a per-unit loop calls something global. And judge whether the
remaining cost is acceptable at the intended scale, including `describeUnit`, which still issues four
store queries plus one subscription fetch.

### 5. Restate coupling that will break on upgrade

- `restate/invocations.ts:mapStatus` detects cancellation with `/^\[409\] Cancel/i` against
  `completion_failure`, and `statusPredicate` does the same with SQL `LIKE '[409] Cancel%'`. This is
  string-matching an error format the Restate server owns. What happens on a Restate upgrade that
  rewords it? Is there a more stable signal?
- The column set read from `sys_invocation`, and the `state` table shape, are similarly coupled.
- The SDK and server versions are pinned (`1.17.2`, and `restate:1.7.10` in the replay test) — is
  that pinning consistent, and what is the upgrade procedure?

### 6. Keyset pagination

`listRunsSql` pages on `(created_at DESC, id DESC)` and compares `id` lexicographically. Verify
against real invocation ids that this ordering is total and stable, that no run can be skipped or
returned twice across pages, and that a tampered or replayed cursor is rejected rather than
misinterpreted. Try: a cursor from a different workflow, a cursor whose timestamp no longer exists,
concurrent inserts during pagination.

### 7. Injection into the Restate SQL endpoint (invariant 13)

`restate/sql.ts` is a `quote()` and two regexes. Attack every value that reaches a query: `workflow`,
`runId`, `status`, `cursor`, deployment ids, and the service names taken from the catalogue (note
those come from the database, not the request — is that trusted correctly?). Try quote-escaping,
unicode normalisation, null bytes, very long values, and DataFusion-specific syntax.

### 8. Kafka trigger semantics

- The run id includes the record timestamp. What happens under a broker configured with
  `LogAppendTime`, or a topic whose timestamps are rewritten on compaction — can two distinct records
  collide, or one record produce two runs?
- Redelivery, rebalance and duplicate delivery: exactly one run per record?
- A malformed record must fail terminally and never block the partition. Verify with a poison record
  and confirm the consumer keeps moving.
- Disabling a trigger is documented as eventually consistent (`disabling` until the subscription is
  gone). Can it get stuck in `disabling`? What reconciles it if core-api dies mid-toggle?
- `kafkaTrigger` builds handler names from trigger ids (`on<TriggerId>`). Are collisions and invalid
  names fully prevented, at both the metadata and the runtime layer?

### 9. Idempotency semantics

`apiRunId` derives the run id from the caller's `Idempotency-Key`. So the _same key with different
input_ returns the first run and silently ignores the new input. Decide whether that is the intended
contract, whether it is documented, and whether a caller can tell what happened. Also: what is the
retention relationship between `idempotencyRetention` and a key being reused after expiry?

### 10. Failure injection

Kill things at the worst moment and check the system converges:

- Postgres down during `POST /v1/deployments`, and during a trigger reconcile.
- Restate admin unreachable mid-registration (after Restate registered, before the catalogue synced —
  invariant 8 says this must come back as a retryable 503 and a retry must fix it).
- A unit container killed mid-run (the e2e crash suite does this; extend it — kill during the LLM
  call, immediately after it returns, and during the journal write).
- LiteLLM or Ollama down or returning 4xx/5xx/timeouts. `retry.llm` is deliberately uncapped so a
  gateway outage _pauses_ the invocation instead of failing it. Verify a paused invocation is
  visible, diagnosable and resumable — and judge whether "paused forever" is an acceptable default.
- Core-api restarted while a deploy is in flight.
- Disk/volume pressure, and `docker compose down` without `-v` followed by a redeploy.

### 11. Security, given no auth

The threat model is explicit (local-only, Host allow-list, cross-site guard). Test its edges anyway:
Host header parsing (`[::1]`, trailing dot, case, port confusion, absolute-form request URIs), the
`sec-fetch-site`/`Origin` logic, request smuggling through the proxy chain, body-limit and timeout
behaviour, and whether error messages leak internals — `CATALOGUE_SYNC_FAILED` embeds raw error text
(truncated to 800 chars), which may carry a connection string. Then assess: what is the minimum that
must be added before this is exposed beyond localhost, and is the current code shaped to accept it?

### 12. Operational gaps

- **CI is written but not active.** The pipeline lives at `docs/ci-workflow.yml`, not
  `.github/workflows/`, because pushing a workflow file needs a token scope this repo's credentials
  lack. So nothing runs automatically yet: `pnpm check` and the replay suite run when someone
  remembers. Read the file, judge whether the two jobs are the right ones, and note that `test:e2e` is
  excluded because a hosted runner has no GPU for Ollama — say what the cheapest honest substitute
  would be (a stub model behind LiteLLM, a self-hosted runner).
- **No coverage measurement** is configured in `vitest.config.ts`. Measure it, and report where the
  gaps are meaningful rather than reporting a percentage.
- **The schema is provisioned, not migrated.** `infra/postgres/init/` is applied by Postgres itself;
  the API assumes the tables exist and issues no DDL. Probe the consequences: what happens on an
  existing volume, where `docker-entrypoint-initdb.d` does not re-run? What is the story for altering
  a column in a real environment, and is the absence of a migration tool the right call at this size?
  Does the API fail usefully if a table really is missing?
- **Unbounded growth**: unit containers and images are never garbage collected and run with
  `--restart unless-stopped`; the fixture's e2e runs accumulate deployments in the catalogue; the Ajv
  validator cache in `json-schema.ts` is keyed per `name@version#hash` and never evicted.
- Health: liveness is static, readiness checks both stores. Is that the right split for a supervisor?
- Secrets: the CLI passes values through `docker run -e KEY` (name only in argv) — verify nothing
  sensitive lands in argv, labels, image metadata or logs. The logger redacts a fixed field list
  (`packages/observability/src/logger.ts`); is it sufficient, and does it cover nested payloads?

### 13. What the recent fixes newly put at risk

These changed in the last round and are therefore the least-proven parts of the system:

- **Per-unit contracts and the digest's lockfile slicing.** `artifact.ts` now hashes only the
  lockfile's `packages:`/`snapshots:` sections, on the reasoning that `importers:` restates declared
  specifiers already covered by each package.json in the closure. Attack that reasoning: find a change
  that alters what reaches a unit's image without changing its digest. A transitive resolution shift, a
  `pnpm.overrides`, a patched dependency, a peer-dependency change, a catalog edit.
- **The scaffold's templates.** They encode conventions that live in several other files. Scaffold a
  unit, deploy it, start a run, and check the whole path — then look for a convention the templates
  get wrong or omit.
- **Provisioning instead of migration.** See above.
- **`resume` and `kill`.** Force a real pause (stop LiteLLM until the retries are exhausted), then
  resume it. Does the run complete? Is the journal intact? Is the LLM step re-executed?
- **The Postman collection** is asserted to cover every route by
  `routes/collection.test.ts`. Check the match is meaningful rather than superficial.

### 14. Do the guardrails actually guard? (meta-testing)

Break things deliberately and confirm something fails. A guardrail that has never been observed
failing is a guardrail you do not have.

- Add `Date.now()` to a workflow handler → does lint fail? Add a subtler non-determinism the lint
  cannot see (iterate a `Set` built from object keys, `Math.max` over an unordered array, read
  `process.env` inside the handler) → does `pnpm test:replay` catch it? **If not, that is a real gap
  in invariant 1**, since lint only covers a fixed pattern list.
- Reformat a unit's source and redeploy without bumping the version → expect
  `VERSION_ARTIFACT_CONFLICT`.
- Introduce a cyclic package dependency, or import an undeclared package → does `turbo boundaries`
  fail?
- Remove a field from a response schema → does any test notice, or does the field just vanish?
- Make `setActive` lie about routing → does a test fail?
- Delete an `await` in a handler → does `no-floating-promises` or a test catch it?

---

## Deliberately out of scope

Do not spend effort arguing these; they are settled decisions recorded in `docs/decisions.md`. Do
flag it if you find one of them **implemented inconsistently with what is written**.

- No auth in v1; localhost-only binding as the boundary.
- Mastra deferred to v2 agent/RAG work.
- No run table — Restate is the run store.
- Run history is Restate's 7-day retention, and is operational history rather than an audit log.
- `--dev` mode overwriting a single endpoint in place, for local iteration only.
- Deferred features: RAG ingestion, MCP server, cron, human-in-the-loop gates, the Restate Operator.

---

## What to deliver

A single report, ordered so the most important thing is first.

**1. Verdict.** Would you put production traffic through this? What must change first? Three to five
sentences, no hedging.

**2. Findings**, each as:

```
[SEV] Title
  Invariant:  which of 1–16 it breaks (or "none — new concern")
  Location:   file:line
  Evidence:   the command, test, or HTTP exchange that demonstrates it — verbatim output
  Impact:     what goes wrong in production, concretely
  Fix:        the change you would make, and its cost
  Confidence: confirmed | plausible (say what would settle it)
```

Severity: **S1** data loss, corruption, security, or silent wrong behaviour · **S2** breaks under
concurrency or failure · **S3** correct but fragile, or wrong under load · **S4** worth improving.

Put unverified suspicions in their own section, explicitly labelled. Do not pad the list — ten real
findings beat forty speculative ones, and a long list of maybes costs the reader more than it gives.

**3. Test-suite assessment.** Not a coverage number: which invariants are genuinely enforced, which
tests would still pass with the code broken, and the specific tests you would add. Include any tests
you wrote during the review, as a patch.

**4. Enhancements**, ranked by value over cost, each with the argument for _and against_ doing it.
Separate "before production" from "later".

**5. What you could not check**, and what access or time you would need to.

---

## Ground rules

- **Run things.** A review of this that never started the stack is not a review. Reading is for
  forming hypotheses; running is for confirming them.
- **Write tests to prove a bug.** A failing test is the strongest possible evidence, and it is also
  the fix's regression guard.
- **Say when you are unsure.** Confident wrongness is more expensive than an acknowledged gap.
- **Ask before anything destructive.** `docker compose down -v` wipes the catalogue, all run history
  and the Langfuse data. `pnpm test:e2e` mutates the running stack and the fixture's `metadata.json`.
  Work on a branch; leave the tree clean or say exactly what you changed.
- **Report honestly.** If a suite fails, show the output. If you skipped something, say so.
