---
description: Run tests, optionally scoped to a package/marker; summarize failures
argument-hint: "[core|enrichment_router|caption_generator] [integration]"
allowed-tools: Bash(pytest *), Bash(make *)
---

Run tests for **ai-pipeline**. Args — package scope: `$1` (may be empty), marker: `$2` (may be empty).

Choose the command:
- no args -> `make test` (unit tests only, excludes `integration` marker)
- `$2` is `integration` -> `make test-integration` (note: requires `make dev-up` to already be running — JanusGraph, Kafka, Azurite)
- `$1` given, no marker -> scope to that package directly, e.g.
  `pytest core/tests -m "not integration"` / `pytest jobs/enrichment_router/tests -m "not integration"` /
  `pytest jobs/caption_generator/tests -m "not integration"`

After running, summarize: total run / passed / failed / skipped. For any failure, surface the **test name** and the first assertion/exception line. If an `integration` test fails with a connection error, note that `make dev-up` may not have been run.

## Examples

```
/test                          # unit tests across core + both jobs
/test caption_generator         # unit tests for caption-generator only
/test caption_generator integration   # integration tests for caption-generator (requires dev-up)
```
