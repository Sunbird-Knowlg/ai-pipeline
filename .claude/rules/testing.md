---
paths:
  - "**/tests/**"
---

# Testing conventions

Stack: **pytest**, `pytest-mock`, plus `mypy` and `ruff` for static checks (all wired through
the root `Makefile`, not run ad hoc).

## Running tests

```bash
make test              # pytest core/tests jobs/enrichment_router/tests jobs/caption_generator/tests -m "not integration"
make test-integration   # same, -m integration; requires `make dev-up` first (JanusGraph, Kafka, Azurite)
make lint               # ruff check core jobs; mypy core/sunbird_ai_core jobs/*/**
```

Each package (`core/`, `jobs/enrichment_router/`, `jobs/caption_generator/`) declares its own
`testpaths` and the `integration` marker in its own `pyproject.toml`; the root `pyproject.toml`
aggregates `testpaths` across all three for a single `pytest` invocation from the repo root.

## Requirements

- **Mock the seams, don't hit real infrastructure in unit tests**: mock `JanusGraphUtil`,
  `BlobStorageUtil`, and `KnowlgClient` (or the specific methods used) rather than connecting to
  a real JanusGraph/blob backend/HTTP endpoint. Reserve real infrastructure for tests marked
  `integration`, which assume `make dev-up` has already been run.
- **Cover normal, edge, and failure paths** — in particular the DLQ path (an exception during
  processing should mark the graph node `Failed` and emit to the DLQ side output — see
  `kafka-contracts.md`), and the "skip, don't process" early-return branches in
  `content_published.py`/`transcript_approved.py`/`is_ecar_ready`.
- Provider tests (`caption_generator/tests/test_*_function.py`) should exercise the
  `TranscriptionProvider`/`MultilingualProvider` ABC boundary with a fake/mock provider rather
  than invoking real `faster-whisper` model inference or real LLM API calls.
- `mypy` is expected to pass cleanly on `core/sunbird_ai_core` and both jobs' packages — the
  `X | None` + `assert ... is not None` narrowing pattern (see `base-class-pattern.md`) exists
  specifically to satisfy it; don't add `# type: ignore` as a shortcut past a genuine "this
  could be `None`" finding.
