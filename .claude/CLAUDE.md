# CLAUDE.md

Guidance for Claude Code when working in the **ai-pipeline** repo.

## Project Overview

**ai-pipeline** is a Python monorepo hosting two Apache PyFlink 1.20 streaming jobs for Sunbird's Knowledge Platform (an open-source EdTech content platform). They add AI-generated video transcripts/captions to content stored as nodes in a JanusGraph knowledge graph.

**Stack:** Python 3.11+ · Apache PyFlink 1.20 · gremlinpython (JanusGraph) · fsspec/adlfs/s3fs/gcsfs (blob storage) · faster-whisper (speech-to-text) · LiteLLM (multilingual translation) · Kafka · pytest · mypy · ruff.

**The two jobs:**

- **`enrichment-router`** (`jobs/enrichment_router/`) — consumes `enriched.metadata` (content-publish and transcript-approval events), reads JanusGraph state, and routes work to downstream Kafka topics. **Read-only** — never writes to the graph directly (it may call the knowlg content API to create Draft Transcript nodes, but that's an HTTP call, not a direct graph write).
- **`caption-generator`** (`jobs/caption_generator/`) — consumes transcription/multilingual-translation request events. Runs `faster-whisper` for source-language captions and an LLM (via LiteLLM) for multilingual translation, uploads WebVTT + JSON caption artifacts to blob storage, and packages a combined ECAR (`.zip`) artifact for offline consumption.

Note: you may see references to "sunbird-ai-platform" in old comments or docstrings — that was the working name before this repo was moved/renamed. **The canonical name going forward is `ai-pipeline`.** Prefer that name in anything you write; correct stale references opportunistically but don't go on an unrelated rename sweep.

## Module Map

```
core/sunbird_ai_core/     # shared package, installed by both jobs (pip install -e core/)
  base/                   # BaseFlinkJob, BaseProcessFunction, BaseJobConfig — shared lifecycle
  config/                 # JobConfig: YAML + SUNBIRD_AI_ env-var overrides
  graph/                  # JanusGraphUtil (gremlinpython) + SchemaRegistry (blob-fetched schemas)
  kafka/                  # @dataclass event schemas (requests, DlqEnvelope)
  knowlg/                 # config-driven HTTP client for the knowlg platform content API
  storage/                # BlobStorageUtil — fsspec wrapper over Azure/AWS/GCP

jobs/enrichment_router/enrichment_router/
  functions/              # content_published.py, transcript_approved.py (pure logic) +
                          #   router_function.py (PyFlink ProcessFunction, side outputs)
  main.py                 # Kafka source -> RouterFunction -> two Kafka sinks

jobs/caption_generator/caption_generator/
  providers/              # TranscriptionProvider / MultilingualProvider ABCs + concrete
                          #   implementations (faster_whisper, litellm) + factory.py registry
  builders/               # vtt_builder.py (WebVTT/JSON), ecar_builder.py (zip packaging)
  segment.py, chunking.py, sync.py, audio.py
  functions/              # transcription_function.py, multilingual_function.py, event_router.py
  main.py                 # merges two Kafka sources -> EventRouter -> two processing paths
  scripts/transcribe_local.py   # standalone dev utility, no Flink/Kafka/JanusGraph needed
```

Each of `core/docs/`, `jobs/enrichment_router/docs/`, `jobs/caption_generator/docs/` has a `README.md` index and walks through the real code file-by-file, written for a Java-background engineer new to Python — read these before making non-trivial changes; they explain *why*, not just *what*.

## Build, Test & Lint

```bash
make install              # pip install -e core/ -e jobs/enrichment_router/ -e jobs/caption_generator/
make test                 # pytest ... -m "not integration"
make test-integration     # pytest ... -m integration (requires `make dev-up` first)
make lint                 # ruff check core jobs && mypy core/sunbird_ai_core jobs/*/**
make dev-up / make dev-down   # docker-compose stack: JanusGraph+Cassandra, Redpanda, Azurite, Flink
make package-enrichment-router / make package-caption-generator   # zip artifacts/*.zip for -pyfs
make submit-router / make submit-capgen   # flink run -py ... -pyfs artifacts/*.zip --config ...
```

Root `pyproject.toml` holds `[tool.pytest.ini_options]` and `[tool.ruff]` only — there is no real installable package at the repo root; each of `core/`, `jobs/enrichment_router/`, `jobs/caption_generator/` is its own package with its own `pyproject.toml`.

## Key Architectural Decisions & Constraints

- **Graph writes always go direct to JanusGraph via gremlinpython, never through a REST/service layer.** `JanusGraphUtil` in `core/sunbird_ai_core/graph/janusgraph_util.py` is the only place Gremlin traversals are built. `enrichment-router` only *reads* through it; `caption-generator` is the job that calls `update_node`.
- **Schema/config validation is fetched from blob storage at runtime via `SchemaRegistry`, never hardcoded or committed locally.** `schema.json`/`config.json` per object type are fetched over HTTP and cached for the process lifetime (no TTL/eviction) — this repo has no local copies of the platform's object schemas.
- **Config overrides go through `SUNBIRD_AI_`-prefixed environment variables, not `${VAR}` substitution.** `JobConfig` (`core/sunbird_ai_core/config/job_config.py`) checks `SUNBIRD_AI_<DOTTED_KEY_UPPERCASED_WITH_UNDERSCORES>` before falling back to the YAML value — e.g. `kafka.brokers` -> `SUNBIRD_AI_KAFKA_BROKERS`. The `${KAFKA_BROKERS}`-style placeholders visible in `config.yaml` files are **cosmetic only** and are not parsed/substituted by any code in this repo — don't assume they work like HOCON.
- **PyFlink's `__init__` (local, once) vs `open()` (remote, per-TaskManager) split is load-bearing.** Anything holding a live connection (`JanusGraphUtil`, `BlobStorageUtil`, `KnowlgClient`) must be constructed in `open()`, never `__init__` — hence every `BaseProcessFunction` subclass attribute is typed `X | None` and narrowed with `assert ... is not None` before use.
- **Providers are pluggable via a class-registry factory, not an if/elif chain.** `caption_generator/providers/factory.py` maps a config string (`transcription.provider`, `multilingual.provider`) to a class object and calls it — adding a new provider is "one new dict entry + one new class," no changes to calling code.
- **Every processing path has its own Kafka DLQ side output.** Any exception during `caption-generator`'s per-element processing marks the relevant graph node `Failed` and routes the original request to a `*.dlq` topic via `ctx.output(DLQ_TAG, ...)` — failures are visible/replayable, never silently swallowed and never crash the TaskManager.
- **Multilingual translation concurrency is thread-based, deliberately, because it's I/O-bound.** `MultilingualFunction` uses one `ThreadPoolExecutor` worker per target language — this is safe/beneficial despite the GIL because the work is waiting on LLM API calls, not CPU-bound computation. There's a known, explicitly-flagged tradeoff: all worker threads share one `JanusGraphUtil` connection (see the `ponytail:` comment in `multilingual_function.py`) — don't "fix" this speculatively without evidence it's actually a problem.
- **LLM output is a trust boundary and is validated, not assumed correct.** `LiteLLMProvider.translate` checks the returned segment ids exactly match the input ids before accepting the response; a mismatch raises and routes to the DLQ.
- **Helm charts for real deployment live in the separate `sunbird-spark-installer` repo.** `deploy/<job>/{Chart.yaml,values.yaml}` here are skeletons documenting the config surface each job expects — don't treat them as the deployable charts.

## Development Workflow

1. Read the relevant `docs/` folder(s) before touching `core/` or job-specific `functions/`/`providers/` code — the docs explain the design intent, not just mechanics.
2. Shared, job-agnostic logic belongs in `core/sunbird_ai_core/`; job-specific business logic belongs under `jobs/<job>/<job>/functions/` (and `providers/`/`builders/` for `caption-generator`).
3. `make lint && make test` before opening a PR. Use `make test-integration` (after `make dev-up`) when touching JanusGraph/Kafka/blob-storage interaction code.
4. Config changes: add the key to the relevant `config.yaml`, expose it via a typed `@property` on `BaseJobConfig` if it's shared across jobs, or via `self._config.raw("dotted.key", default)` if it's job-specific.

## Rules

Path-scoped rules live in `.claude/rules/` (auto-discovered, loaded only when a matching file is open):

| Rule file | Loads on |
|---|---|
| `base-class-pattern.md` | `core/sunbird_ai_core/base/**`, `**/functions/**.py` — `BaseFlinkJob`/`BaseProcessFunction` lifecycle, `open()`/`close()`, the `X \| None` typing convention |
| `graph-access.md` | `core/sunbird_ai_core/graph/**`, `**/functions/**.py` — direct-gremlinpython-only rule, read-only vs read-write boundary between the two jobs |
| `configuration-discipline.md` | `**/config.yaml`, `core/sunbird_ai_core/config/**` — `SUNBIRD_AI_` env override convention, the `${VAR}` non-substitution gotcha |
| `schema-validation.md` | `core/sunbird_ai_core/graph/schema_registry.py`, `**/sync.py` — schema/config fetched from blob storage at runtime, never hardcoded |
| `provider-pattern.md` | `jobs/caption_generator/caption_generator/providers/**` — ABC + class-registry factory extensibility pattern |
| `kafka-contracts.md` | `**/functions/**.py`, `core/sunbird_ai_core/kafka/**` — topic contracts, side outputs, DLQ envelope pattern |
| `testing.md` | `**/tests/**` — pytest markers, mocking `JanusGraphUtil`/`BlobStorageUtil`/`KnowlgClient`, mypy/ruff |

## Commands

Slash-commands live in `.claude/commands/` (type `/<name>`):

| Command | Use |
|---|---|
| `/test [target]` | Run `make test` (or a scoped `pytest` invocation), summarize failures |
| `/lint` | Run `ruff check` + `mypy` via `make lint`, summarize findings |
| `/build [job]` | Package a job's zip artifact via `make package-<job>` |
| `/commit [hint]` | Conventional Commits commit for this repo |
