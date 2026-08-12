# ai-pipeline

Apache PyFlink 1.20 streaming jobs that add AI-generated video transcripts and multilingual captions to Sunbird's Knowledge Platform.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/python-3.11%2B-blue)
![PyFlink](https://img.shields.io/badge/pyflink-1.20-orange)

## Overview

Sunbird's Knowledge Platform stores every piece of content (videos, documents, question sets, etc.) as a node in a JanusGraph knowledge graph. This repository hosts two independent, always-running Flink jobs that together turn a freshly published video into a fully captioned, multilingual, offline-ready piece of content, without either job ever blocking the platform's own publish path:

```
                         enriched.metadata (Kafka)
                                  |
                                  v
                    +---------------------------+
                    |     enrichment-router      |   read-only: never writes to the graph
                    |  (reads JanusGraph state,   |
                    |   decides what to trigger)  |
                    +---------------------------+
                        |                    |
                        v                    v
        media.transcription.request   media.multilingual.request
                        |                    |
                        v                    v
                    +---------------------------------------+
                    |            caption-generator            |
                    |  faster-whisper (speech-to-text)         |
                    |  LiteLLM (multilingual translation)      |
                    |  fsspec (blob upload) + ECAR packaging   |
                    +---------------------------------------+
                        |                              |
                        v                              v
              WebVTT + JSON captions           combined ECAR (.zip)
              uploaded to blob storage         for offline consumption
```

**`enrichment-router`** consumes the `enriched.metadata` topic, which carries two kinds of events discriminated by `contentType`/`action`:

- **Content-published** — a new/updated video. The router checks JanusGraph for an `Enrichment` node and a source-language `Transcript` node in a triggerable state (no existing captions, not already in progress). If eligible, it emits a `MediaTranscriptionRequest` to `media.transcription.request`.
- **Transcript-approved** — a source-language transcript has been approved. The router determines which configured target languages don't already have an active translation, creates `Draft` Transcript nodes for them via the knowlg platform's content API, and emits a `MediaMultilingualRequest` to `media.multilingual.request`.

The router is deliberately **read-only** against the graph — the only graph-mutating call in this job's dependency chain is the knowlg content API used to create new Transcript nodes, never a direct graph write.

**`caption-generator`** consumes both request topics (merged via a single Flink `.union()`), and splits into two independent processing paths:

- **Transcription** — downloads the source video, extracts audio with `ffmpeg`, runs `faster-whisper` for speech-to-text, builds WebVTT + a segment-level `transcript.json`, uploads both to blob storage, and updates the source Transcript node's status (`Live` or `Review`, depending on `auto_approve`).
- **Multilingual translation** — downloads the source-language transcript JSON, chunks it into overlapping batches, translates each batch concurrently (one worker thread per target language) via an LLM through LiteLLM, validates the LLM's response against the original segment ids, merges/dedupes the translated batches back into an ordered transcript, and uploads WebVTT + JSON per language.

After every language update, the Enrichment node's denormalized `transcripts` snapshot is refreshed. Once the source language is `Live` and every target language is in an acceptable terminal state, the job packages a combined **ECAR** (a `.zip` archive, Knowledge Platform's offline-content-package convention) containing a manifest plus every language's captions, uploads it, and records its URL on the Enrichment node for offline/low-connectivity consumption.

Both jobs share failure handling via Kafka **dead-letter topics**: any exception during processing marks the relevant graph node `Failed` and routes the original request event to a `*.dlq` topic through a Flink side output, so failures are visible and replayable without crashing the job.

### Why these design choices

- **PyFlink over Java/Scala Flink** — the AI tooling this needs (`faster-whisper`, LiteLLM's multi-provider LLM client) is Python-native; PyFlink lets these jobs live in the same streaming/Kafka ecosystem as the platform's existing Scala Flink jobs without reimplementing ML inference bindings in the JVM.
- **gremlinpython for JanusGraph** — the official Apache TinkerPop Python driver, the direct sibling of the `gremlin-driver` Java library the platform's other jobs already use — same wire protocol, same Gremlin traversal semantics, just from Python.
- **fsspec for blob storage** — a single filesystem-like abstraction over Azure/AWS/GCP blob backends (`adlfs`/`s3fs`/`gcsfs`), so job code never imports a cloud-specific SDK directly; switching cloud providers is a config change, not a code change.
- **Schema-driven graph writes, no hardcoded schemas** — `SchemaRegistry` fetches `schema.json`/`config.json` per object type from blob storage at runtime and caches them for the process lifetime, mirroring the `DefinitionFactory`/`SchemaValidatorFactory` pattern used elsewhere on the platform. There are no locally-committed copies of the platform's object schemas in this repo.

## Repository Structure

```
ai-pipeline/
├── core/                      # shared Python package: sunbird_ai_core
│   ├── sunbird_ai_core/
│   │   ├── base/               # BaseFlinkJob, BaseProcessFunction, BaseJobConfig
│   │   ├── config/             # YAML + env-var-override config loading
│   │   ├── graph/               # JanusGraphUtil (gremlinpython) + SchemaRegistry
│   │   ├── kafka/               # @dataclass event schemas (requests, DLQ envelope)
│   │   ├── knowlg/              # config-driven HTTP client for the knowlg platform API
│   │   └── storage/             # fsspec-based multi-cloud blob storage util
│   ├── tests/
│   ├── docs/                   # concept-by-concept walkthrough of every module here
│   └── pyproject.toml
├── jobs/
│   ├── enrichment_router/       # read-only router job (see docs/ for a full walkthrough)
│   └── caption_generator/       # transcription + multilingual translation job
│       └── scripts/transcribe_local.py   # standalone dev utility, no Flink/Kafka/JanusGraph needed
├── docker/                     # Dockerfiles for both jobs + docker-compose.yml for local dev
├── Makefile                    # install/test/lint/package/submit targets
└── pyproject.toml              # root-level: pytest + ruff config only, no real package here
```

Every `docs/` folder under `core/` and `jobs/*/` is a from-scratch, concept-by-concept walkthrough of the real code in that directory — start with `core/docs/README.md`.

## Prerequisites

- Python 3.11+
- Docker + Docker Compose (for the local dev stack: JanusGraph, Cassandra, Redpanda/Kafka, Azurite blob emulator, Flink)
- `ffmpeg` on `PATH` if you want to run `caption-generator`'s transcription path locally (it shells out to `ffmpeg` for audio extraction)

## Local Development Setup

```bash
# 1. Create and activate a virtual environment
python3.11 -m venv .venv
source .venv/bin/activate

# 2. Install core + both jobs, editable
make install
# equivalent to:
#   pip install -e core/
#   pip install -e jobs/enrichment_router/ -e jobs/caption_generator/

# 3. Bring up the local dependency stack (JanusGraph+Cassandra, Redpanda, Azurite, Flink)
make dev-up
# ... work ...
make dev-down
```

`make dev-up`/`make dev-down` wrap `docker-compose -f docker/docker-compose.yml up -d` / `down`.

To try the caption-generation model against a local video file without any of the above infrastructure, use the standalone dev script instead:

```bash
python jobs/caption_generator/scripts/transcribe_local.py path/to/video.mp4 --output-dir out/
# writes out/transcript.json and out/captions.vtt
```

## Running Tests

```bash
make test              # unit tests only (excludes the `integration` marker)
make test-integration   # integration tests, requires `make dev-up` first
```

These wrap:

```bash
pytest core/tests jobs/enrichment_router/tests jobs/caption_generator/tests -m "not integration"
pytest core/tests jobs/enrichment_router/tests jobs/caption_generator/tests -m integration
```

The `integration` marker (declared in each package's `pyproject.toml`) flags tests that need the docker-compose stack (JanusGraph, Kafka, and — for `caption-generator` — Azurite) actually running.

Lint/type-check:

```bash
make lint
# ruff check core jobs
# mypy core/sunbird_ai_core jobs/enrichment_router/enrichment_router jobs/caption_generator/caption_generator
```

## Configuration

Each job reads a single `config.yaml` (see `jobs/enrichment_router/config.yaml` and `jobs/caption_generator/config.yaml` for the full real shape — Kafka topics, JanusGraph host, schema base path, knowlg API config, cloud storage settings, and job-specific settings like `transcription.model` or `multilingual.batch_size`).

Any dotted config key can be overridden by an environment variable named `SUNBIRD_AI_<KEY_PATH>` (dots replaced with underscores, upper-cased) — e.g. `kafka.brokers` is overridden by `SUNBIRD_AI_KAFKA_BROKERS`. Environment variables always take precedence over the YAML file.

Note the `${VAR}` placeholders you'll see in `config.yaml` (e.g. `brokers: ${KAFKA_BROKERS}`) are **not** automatically substituted — that syntax is currently cosmetic documentation of intent only, and the actual override mechanism is the `SUNBIRD_AI_`-prefixed env var described above, not the literal name inside `${}`. See `core/docs/01_config.md` for the full explanation of this gotcha.

## Packaging & Deployment

Each job is packaged as a flat, zipped Python environment (`sunbird_ai_core` + the job's own package installed side-by-side) for submission to a Flink cluster via `-pyfs`:

```bash
make package-enrichment-router   # -> artifacts/enrichment-router.zip
make package-caption-generator   # -> artifacts/caption-generator.zip

make submit-router     # flink run -py .../main.py -pyfs artifacts/enrichment-router.zip --config .../config.yaml
make submit-capgen     # flink run -py .../main.py -pyfs artifacts/caption-generator.zip --config .../config.yaml
```

`docker/Dockerfile.enrichment-router` and `docker/Dockerfile.caption-generator` build container images on top of the official `flink` image, installing Python 3.11 and both packages (`caption-generator`'s image additionally installs `ffmpeg`).

The real, deployable Helm charts live in the separate `sunbird-spark-installer` repository, under `helmcharts/knowledgebb/charts/py-flink/values.yaml` — that file's `py_flink_jobs.<job>.config` block is what's actually rendered into each job's ConfigMap in the cluster. `jobs/<job>/config.yaml` in this repo is the local-dev counterpart, kept deliberately in sync with only the config keys that job's code actually reads (see the comments on each `knowlg.apis`/`cloud_storage_*`/etc. block for which keys are load-bearing vs. unused) — when adding or removing a config key here, mirror the same change in that chart's `values.yaml`.

## Contributing

Before changing anything in `core/`, read `core/docs/README.md` (start with `00_python_foundations.md` if you're newer to Python) — it walks through every module's actual code, not just a high-level description. Each job then has its own `docs/README.md` index covering that job's PyFlink-specific pipeline wiring.

Run `make lint` and `make test` before opening a PR. New shared functionality belongs in `core/sunbird_ai_core`; job-specific business logic belongs under `jobs/<job>/<job>/functions/`.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).
