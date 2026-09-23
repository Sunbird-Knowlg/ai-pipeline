# The reference workflow: `content-authoring`

This is the example to copy when you write a new workflow. It exists to show every decision a real
workflow has to make, once each, in a domain that is not a toy: DIKSHA publishes a content item, and
the pipeline turns it into an **authoring pack** — a summary, extracted metadata, and a quiz.

`workflows/content-enrichment` is the _minimal_ example: one trigger's worth of thinking and one
service call. Read that one to see the skeleton. Read this one when you are about to write something
real.

## What it does

A payload arrives — from REST, or from Kafka as a DIKSHA `content.published`-style event — carrying
a content identifier, a name, a description and the text of the resource:

```jsonc
{
  "contentId": "do_31309317310697472011526",
  "name": "Photosynthesis in Green Plants",
  "description": "An introduction to how green plants make their own food using sunlight.",
  "text": "Photosynthesis is the process by which green plants make their own food. …",
  "subject": "Science",
  "gradeLevel": "Class 7",
}
```

and the run returns:

```jsonc
{
  "contentId": "do_31309317310697472011526",
  "name": "Photosynthesis in Green Plants",
  "summary": "Photosynthesis is how green plants create their own food using sunlight. …",
  "metadata": {
    "keywords": ["photosynthesis", "chlorophyll", "glucose", "oxygen", "stomata", "…"],
    "concepts": ["energy conversion", "plant biology", "ecological importance"],
    "difficulty": "beginner",
    "language": "en",
    "subject": "Science",
    "gradeLevel": "Class 7",
    "wordCount": 96,
    "readingTimeMinutes": 0.5,
  },
  "quiz": {
    "questions": [
      {
        "question": "What is the primary function of chlorophyll in green plants?",
        "options": [
          "To absorb light energy from the sun",
          "To convert glucose into oxygen",
          "To filter carbon dioxide from the air",
          "To transport water through the roots",
        ],
        "answerIndex": 0,
      },
    ],
    "discarded": 0,
  },
  "provenance": {
    "trigger": "rest",
    "version": "0.1.0",
    "models": { "summary": "chat-default", "metadata": "chat-default", "quiz": "chat-default" },
    "authoredAt": 1790157524543,
  },
}
```

## The shape

```
REST  ──► core-api ──(restate-sdk-clients)──┐
                                            ▼
                                     ContentAuthoring ─┬─► SummaryService          ─┐
Kafka ──► ContentAuthoringTrigger ──────────┘  (workflow)│                           ├ parallel
   diksha.content.published                              └─► ContentMetadataService ─┘
                                                              │
                                                              └─► QuizGenerateService   (needs the
                                                                    concepts the previous step found)
```

Three shared services, two of them called at the same time and the third after them because it
genuinely depends on their answer. That difference — **parallel where independent, sequential where
not** — is most of what there is to learn about composing a workflow.

## The units

| Unit                                 | What it owns                                                            |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `workflows/content-authoring`        | the workflow, its two triggers, its adapter and its deterministic steps |
| `services/summary`                   | one LLM call: summarise (already existed; this is its second caller)    |
| `services/content-metadata`          | one LLM call: keywords, concepts, difficulty                            |
| `services/quiz-generate`             | one LLM call: multiple-choice questions                                 |
| `packages/contract-summary`          | the schemas + `restate.iface` binding both sides of `summary` share     |
| `packages/contract-content-metadata` | likewise for `content-metadata`                                         |
| `packages/contract-quiz-generate`    | likewise for `quiz-generate`                                            |

Each of these was created with `pnpm pipeline new`, not by hand.

## Reading the handler

`workflows/content-authoring/src/workflow.ts` is about seventy lines. They go in this order, and the
order is the lesson.

### 1. Record where the run came from

```ts
ctx.set('trigger', trigger);
ctx.set('version', metadata.version);
```

The runs API reads these back. They are written by the handler rather than derived from the run id,
so `GET /v1/runs/content-authoring/<id>` can say "this came from Kafka partition 2, offset 0" and be
believed. A caller cannot forge it: the trigger context is built by the control plane, never taken
from the request body.

### 2. Put the input in order, deterministically

```ts
const text = authoringText(input);
```

`authoringText` is a **step**: a plain function in `src/steps.ts`. Not a service, not catalogued, not
journaled. It runs again on every replay, which is exactly why it must be pure — same input, same
output, no clock, no randomness, no I/O. In exchange it costs nothing and is trivial to unit test,
which is where policy-like logic belongs.

### 3. Call the shared services

```ts
const [summary, extracted] = await restate.RestatePromise.all([
  ctx.client(summaryApi).summarize({ text, maxWords: config.summaryMaxWords }),
  ctx.client(contentMetadataApi).extract({ text, maxKeywords: config.maxKeywords }),
]);

const quiz = await ctx.client(quizGenerateApi).generate({
  text,
  questionCount: config.questionCount,
  focus: extracted.concepts,
});
```

Three things worth noticing:

- **`RestatePromise.all`, not `Promise.all`.** A native combinator settles in whatever order the
  network answered in; a replay would not agree with the first attempt, and the journal would
  mismatch. Lint fails the build on `Promise.all` inside a handler.
- **`ctx.client(api)` is a durable call.** The workflow suspends, and the service's own journal owns
  its retries. Nothing here needs a try/catch for a flaky gateway.
- **The quiz call is sequential on purpose.** It takes `focus: extracted.concepts`, so it cannot
  start until the metadata step answered. A data dependency is the only good reason to give up
  concurrency — if you find yourself awaiting two independent calls one after the other, that is a
  bug, not a style.

### 4. The one side effect the workflow owns

```ts
await ctx.run('publish.pack-ready', () => publish({ … }), retry.db);
```

Everything else this workflow does is a call to a service that owns its own I/O. This one
announcement is its own, and it must happen **once per run, not once per replay** — which is the
entire purpose of `ctx.run`. Outside it, the line would be emitted again every time the handler
replayed.

`publish` is a _parameter_ of `createContentAuthoring`, not an import, for the same reason
`services/summary` takes `generate` as a parameter: the replay test substitutes a counter and proves
the step ran exactly once while the body ran many times. You can see the same thing on the running
stack:

```sh
docker logs $(docker ps --format '{{.Names}}' | grep content-authoring) | grep -c 'authoring pack ready'
# one line per completed run, however many times the handler replayed
```

### 5. Return the pack

The output includes `provenance.models` — which model answered for each capability. When an editor
says a quiz is wrong, that is the field that turns a complaint into an investigation.

## The two triggers

Both are declared in `metadata.json` and reconciled by the control plane on deploy. Nothing in the
handler knows which one started it, beyond the `trigger` it was handed.

```jsonc
"triggers": [
  { "id": "api", "type": "rest" },
  {
    "id": "diksha-content-published",
    "type": "kafka",
    "cluster": "local",
    "topic": "diksha.content.published",
    "adapter": "dikshaContentPublished"
  }
]
```

A Kafka trigger also needs its topic to exist — `kafka-init` in `compose.yaml` creates it, because
auto-creation is off.

### The adapter is where the vocabulary changes

`src/adapters.ts` is a pure function from the platform's event to this workflow's canonical input.
It has three outcomes, and the difference between them is operational:

| Outcome  | Meaning                                    | What Restate does                  |
| -------- | ------------------------------------------ | ---------------------------------- |
| an input | this record is ours                        | starts a run                       |
| `null`   | this record was never ours                 | drops it, silently, no run         |
| throws   | this record **is** ours and arrived broken | fails it terminally, never retries |

The rule of thumb: **be silent about events that are not yours, and loud about ones that are but
arrived broken.** Here, a `Collection` or a `Draft` is skipped; a `Live` `Content` with no body,
transcript or description throws, because that is a producer bug and hiding it helps nobody. A
terminal failure is logged in Restate and does not block the partition:

```
[400] adapter rejected the Kafka record: content do_qa_bad_empty is Live but carries no body, …
```

The adapter also translates: DIKSHA sends `subject`, `gradeLevel` and `language` sometimes as a
string and sometimes as an array, and names languages in full (`["Hindi"]`). The workflow's contract
takes a single ISO code. Normalising that is the adapter's job — the contract does not bend to the
producer.

### Run ids

The trigger derives the run id from the record's coordinates (cluster, trigger, topic, partition,
offset, timestamp), so a redelivered record lands on the same run and Restate deduplicates it. REST
derives it from the `Idempotency-Key`, or makes one up when there is none. Either way the id is
opaque: `kf_…` or `api_…`, and nothing parses it back.

## Where the contracts live, and why

`content-authoring` keeps its own contract in `src/contract.ts`, because nothing calls it. The three
services keep theirs in `packages/contract-<name>`, because a **second** unit — this workflow —
needs them.

That is not tidiness. A unit's artifact digest covers its own sources _and those of every workspace
dependency_. A shared registry of contracts would be a file every unit depended on, so adding one
workflow would change every other unit's artifact and force a round of version bumps. Moving a
contract into a package only when a second unit needs it keeps that blast radius honest.

Every contract is split into `schemas.ts` (zod) and `api.ts` (`restate.iface`), so tools that only
read schemas — the deploy CLI, the catalogue — never load the Restate SDK.

## Config

`metadata.json` carries operational config only, and it is validated against the contract's config
schema at import, so a bad value fails at boot rather than mid-run:

```jsonc
"config": { "summaryMaxWords": 80, "maxKeywords": 8, "questionCount": 3 }
```

Those three numbers are the only knobs. They are passed to the services as call arguments — the
services have no opinion about the caller's budget, and the caller does not reach into the service's
settings.

## What the tests prove

| Level                                       | Proves                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/steps.test.ts`, `src/adapters.test.ts` | the pure functions, including every skip and every failure path of the adapter             |
| `src/schemas.test.ts`                       | the contract, **and the arithmetic**: the largest valid input still fits all three callees |
| `services/*/src/prompt.test.ts`             | the prompts, and how a malformed model reply is read back                                  |
| `src/content-authoring.replay.test.ts`      | the handler under always-replay: the body runs many times, each journaled step runs once   |
| `tests/e2e/content-authoring.test.ts`       | the whole path on the real stack and the real model: catalogue, both triggers, the output  |

The replay test is the one that catches the mistakes that are expensive in production. It forces the
Restate server to replay at every await, and asserts the two counters:

```ts
expect(runExecutions).toBeGreaterThan(1); // the body really did replay
expect(generate).toHaveBeenCalledTimes(3); // …yet each model call happened once
expect(publish).toHaveBeenCalledTimes(1); // …and so did the side effect
```

A `Date.now()` or a `Promise.all` in the handler fails it. So does lint, earlier and more cheaply.

## Run it yourself

```sh
pnpm pipeline deploy summary content-metadata quiz-generate   # dependencies first
pnpm pipeline deploy content-authoring

# REST
curl -s localhost:3000/v1/workflows/content-authoring/runs \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
  -d '{"input":{"contentId":"do_1","name":"Photosynthesis","text":"Green plants use sunlight to make food. Chlorophyll in the leaves absorbs light energy…","subject":"Science","gradeLevel":"Class 7"}}'

pnpm pipeline run content-authoring <runId>

# Kafka
echo '{"objectType":"Content","identifier":"do_2","edata":{"state":"Live","name":"The Water Cycle","body":"Heat from the sun makes water evaporate…","language":["Hindi"]}}' | \
  docker compose exec -T kafka /opt/kafka/bin/kafka-console-producer.sh \
    --bootstrap-server localhost:9092 --topic diksha.content.published

pnpm pipeline runs content-authoring
```

A run takes about a minute on the local `qwen3.5:4b` — three model calls, two of them concurrent.

## Copying it

```sh
pnpm pipeline new workflow <name> --kafka <topic>
pnpm install
```

Then, in order:

1. **`src/schemas.ts`** — input, output, config, and the producer's event shape. Be strict about
   what you need (`z.strictObject`) and loose about what the producer may add
   (`z.looseObject`). Bound your maxima by what your callees accept, and put that arithmetic in a
   test.
2. **`metadata.json`** — the triggers, the dependencies, the config. Add the Kafka topic to
   `kafka-init` in `compose.yaml`.
3. **`src/adapters.ts`** — map the event. Decide deliberately which records are skipped and which
   are failures.
4. **`src/steps.ts`** — the deterministic parts. Everything that is a rule rather than a model call
   belongs here, where it can be tested in milliseconds.
5. **`src/workflow.ts`** — the orchestration. All I/O inside `ctx.run` or behind a service call;
   `ctx.date.now()` and `ctx.rand` instead of the wall clock; `RestatePromise` instead of native
   combinators.
6. **Tests** — unit tests beside the code, then a `*.replay.test.ts`, then an e2e suite.
7. **`pnpm check`**, then `pnpm test:replay`, then deploy.

A capability more than one workflow will want is a **service**, not a step: give it its own unit,
put its schemas in `packages/contract-<name>` the moment a second unit calls it, and declare it in
`dependencies`.
