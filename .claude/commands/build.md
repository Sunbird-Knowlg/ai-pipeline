---
description: Package a job's zip artifact for Flink submission (-pyfs)
argument-hint: "[enrichment-router|caption-generator]"
allowed-tools: Bash(make *)
---

Package **ai-pipeline** job artifact(s). Job argument (may be empty): `$1`

- No job given -> package both: `make package-enrichment-router && make package-caption-generator`
- `enrichment-router` -> `make package-enrichment-router` (produces `artifacts/enrichment-router.zip`)
- `caption-generator` -> `make package-caption-generator` (produces `artifacts/caption-generator.zip`)

Each target does a fresh `rm -rf dist/<job>`, `pip install -e core/ -t dist/<job>/`, `pip install -e jobs/<job>/ -t dist/<job>/`, then zips `dist/<job>/` into `artifacts/<job>.zip`. On success, report the artifact path and size. On failure, quote the first pip install error — a common cause is a missing system dependency (e.g. `ffmpeg` for caption-generator's local dev, though the packaging step itself is pure-Python).

Submitting to a running Flink cluster afterward uses `make submit-router` / `make submit-capgen` (not part of this command — mention it as a next step, don't run it unprompted since it submits to whatever Flink cluster the environment is pointed at).

## Examples

```
/build                       # package both jobs
/build caption-generator      # package caption-generator only
```
