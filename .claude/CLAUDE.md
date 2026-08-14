# CLAUDE.md

Guidance for Claude Code when working in the **ai-pipeline** repo.

## Project Overview

**ai-pipeline** is a Python monorepo hosting two Apache PyFlink 1.20 streaming jobs for Sunbird's Knowledge Platform (an open-source EdTech content platform). They add AI-generated video transcripts/captions to content on the platform. Neither job connects to a graph database or any other platform datastore directly — all platform reads/writes go through the knowlg content HTTP API (`KnowlgClient`).

**Stack:** Python 3.11+ · Apache PyFlink 1.20 · fsspec/adlfs/s3fs/gcsfs (blob storage) · faster-whisper (speech-to-text) · LiteLLM (multilingual translation) · Kafka · pytest · mypy · ruff.

**The two jobs:**

- **`enrichment-router`** (`jobs/enrichment_router/`) — consumes `enriched.metadata` (content-publish and transcript-approval events), calls the knowlg content API to check eligibility (e.g. an existing `Enrichment` node, a triggerable source-language `Transcript`), and routes work to downstream Kafka topics (`media.transcription.request`, `media.multilingual.request`). It may create Draft Transcript nodes via that same HTTP API but makes no other platform writes.
- **`caption-generator`** (`jobs/caption_generator/`) — consumes those two request topics. Runs `faster-whisper` for source-language captions and an LLM (via LiteLLM) for multilingual translation, uploads WebVTT + JSON caption artifacts to blob storage, and updates each Transcript node's status (`Live`/`Review`/`Failed`) via the knowlg content API.

Note: you may see references to "sunbird-ai-platform" in old comments or docstrings — that was the working name before this repo was moved/renamed. **The canonical name going forward is `ai-pipeline`.** Prefer that name in anything you write; correct stale references opportunistically but don't go on an unrelated rename sweep.

## Module Map

```
core/sunbird_ai_core/     # shared package, installed by both jobs (pip install -e core/)
  base/                   # BaseFlinkJob, BaseProcessFunction, BaseJobConfig — shared lifecycle
  config/                 # JobConfig: YAML + SUNBIRD_AI_ env-var overrides
  kafka/                  # @dataclass event schemas (requests, DlqEnvelope)
  knowlg/                 # config-driven HTTP client for the knowlg platform content API
  storage/                # BlobStorageUtil — fsspec wrapper over Azure/AWS/GCP

jobs/enrichment_router/enrichment_router/
  functions/              # content_published.py, transcript_approved.py (pure logic) +
                          #   router_function.py (plain PyFlink ProcessFunction, side outputs)
  main.py                 # Kafka source -> RouterFunction -> two Kafka sinks

jobs/caption_generator/caption_generator/
  providers/              # TranscriptionProvider / MultilingualProvider ABCs + concrete
                          #   implementations (faster_whisper, litellm) + factory.py registry
  builders/               # vtt_builder.py (WebVTT/JSON transcript sidecar)
  segment.py, chunking.py, audio.py
  functions/              # transcription_function.py, multilingual_function.py, event_router.py
  main.py                 # merges two Kafka sources -> EventRouter -> two processing paths
  scripts/transcribe_local.py   # standalone dev utility, no Flink/Kafka needed
```

Each of `core/docs/`, `jobs/enrichment_router/docs/`, `jobs/caption_generator/docs/` has a `README.md` index and walks through the real code file-by-file, written for a Java-background engineer new to Python — read these before making non-trivial changes; they explain *why*, not just *what*.

## Build, Test & Lint

```bash
make install              # pip install -e core/ -e jobs/enrichment_router/ -e jobs/caption_generator/
make test                 # pytest ... -m "not integration"
make test-integration     # pytest ... -m integration (requires `make dev-up` first)
make lint                 # ruff check core jobs && mypy core/sunbird_ai_core jobs/*/**
make dev-up / make dev-down   # docker-compose stack: Redpanda, Azurite, Flink (+ JanusGraph/
                          #   Cassandra services still defined in docker/docker-compose.yml but
                          #   unused by any job code today — don't infer a graph dependency from them)
make package-enrichment-router / make package-caption-generator   # zip artifacts/*.zip for -pyfs
make submit-router / make submit-capgen   # flink run -py ... -pyfs artifacts/*.zip --config ...
```

Root `pyproject.toml` holds `[tool.pytest.ini_options]` and `[tool.ruff]` only — there is no real installable package at the repo root; each of `core/`, `jobs/enrichment_router/`, `jobs/caption_generator/` is its own package with its own `pyproject.toml`.

## Key Architectural Decisions & Constraints

- **All platform reads/writes go through `KnowlgClient` (`core/sunbird_ai_core/knowlg/knowlg_client.py`), a config-driven HTTP client — never a direct datastore connection.** There is no graph/database client anywhere in this repo. `enrichment-router` only reads (plus Draft-Transcript creation); `caption-generator` is the job that patches Transcript status.
- **Config overrides go through `SUNBIRD_AI_`-prefixed environment variables, not `${VAR}` substitution.** `JobConfig` (`core/sunbird_ai_core/config/job_config.py`) checks `SUNBIRD_AI_<DOTTED_KEY_UPPERCASED_WITH_UNDERSCORES>` before falling back to the YAML value — e.g. `kafka.brokers` -> `SUNBIRD_AI_KAFKA_BROKERS`. The `${KAFKA_BROKERS}`-style placeholders visible in `config.yaml` files are **cosmetic only** and are not parsed/substituted by any code in this repo — don't assume they work like HOCON.
- **PyFlink's `__init__` (local, once) vs `open()` (remote, per-TaskManager) split is load-bearing.** Anything holding a live connection or client (`BlobStorageUtil`, `KnowlgClient`) must be constructed in `open()`, never `__init__` — hence every `BaseProcessFunction` subclass attribute is typed `X | None` and narrowed with `assert ... is not None` before use.
- **Providers are pluggable via a class-registry factory, not an if/elif chain.** `caption_generator/providers/factory.py` maps a config string (`transcription.provider`, `multilingual.provider`) to a class object and calls it — adding a new provider is "one new dict entry + one new class," no changes to calling code.
- **`caption-generator`'s two processing paths each have their own Kafka DLQ side output; `enrichment-router` does not.** Any exception during `caption-generator`'s per-element processing marks the relevant Transcript node `Failed` (via `knowlg.patch(...)`) and routes the original request to a `*.dlq` topic via `BaseProcessFunction.emit_to_dlq`. `enrichment-router`'s `RouterFunction` logs and drops a failed event instead — don't assume it has the same DLQ safety net.
- **Multilingual translation concurrency is thread-based, deliberately, because it's I/O-bound.** `MultilingualFunction` uses one `ThreadPoolExecutor` worker per target language — this is safe/beneficial despite the GIL because the work is waiting on LLM API calls, not CPU-bound computation.
- **LLM output is a trust boundary and is validated, not assumed correct.** `LiteLLMProvider.translate` checks the returned segment ids overlap the input ids at all before accepting any part of the response; a batch with zero overlap raises (routes to the DLQ), and a partial id mismatch falls back to original text for the unmatched segments while signaling `had_fallback=True` so the caller forces the transcript to `Review` instead of auto-approving to `Live`.
- **Helm charts for real deployment live in the separate `sunbird-spark-installer` repo**, under `helmcharts/knowledgebb/charts/py-flink/values.yaml` — `jobs/<job>/config.yaml` in this repo is the local-dev counterpart, kept in sync by hand; there is no local `deploy/` directory in this repo.

## Development Workflow

1. Read the relevant `docs/` folder(s) before touching `core/` or job-specific `functions/`/`providers/` code — the docs explain the design intent, not just mechanics.
2. Shared, job-agnostic logic belongs in `core/sunbird_ai_core/`; job-specific business logic belongs under `jobs/<job>/<job>/functions/` (and `providers/`/`builders/` for `caption-generator`).
3. `make lint && make test` before opening a PR. Use `make test-integration` (after `make dev-up`) when touching Kafka/blob-storage interaction code.
4. Config changes: add the key to the relevant `config.yaml`, expose it via a typed `@property` on `BaseJobConfig` if it's shared across jobs, or via `self._config.raw("dotted.key", default)` if it's job-specific.

## Rules

Path-scoped rules live in `.claude/rules/` (auto-discovered, loaded only when a matching file is open):

| Rule file | Loads on |
|---|---|
| `base-class-pattern.md` | `core/sunbird_ai_core/base/**`, `**/functions/**.py` — `BaseFlinkJob`/`BaseProcessFunction` lifecycle, `open()`/`close()`, the `X \| None` typing convention |
| `configuration-discipline.md` | `**/config.yaml`, `core/sunbird_ai_core/config/**` — `SUNBIRD_AI_` env override convention, the `${VAR}` non-substitution gotcha |
| `provider-pattern.md` | `jobs/caption_generator/caption_generator/providers/**` — ABC + class-registry factory extensibility pattern |
| `kafka-contracts.md` | `**/functions/**.py`, `core/sunbird_ai_core/kafka/**` — topic contracts, side outputs, DLQ envelope pattern |
| `testing.md` | `**/tests/**` — pytest markers, mocking `BlobStorageUtil`/`KnowlgClient`, mypy/ruff |

## Commands

Slash-commands live in `.claude/commands/` (type `/<name>`):

| Command | Use |
|---|---|
| `/test [target]` | Run `make test` (or a scoped `pytest` invocation), summarize failures |
| `/lint` | Run `ruff check` + `mypy` via `make lint`, summarize findings |
| `/build [job]` | Package a job's zip artifact via `make package-<job>` |
| `/commit [hint]` | Conventional Commits commit for this repo |
