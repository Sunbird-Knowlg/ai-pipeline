---
paths:
  - "**/config.yaml"
  - "core/sunbird_ai_core/config/**"
  - "core/sunbird_ai_core/base/base_job_config.py"
---

# Configuration discipline

There is exactly one config loader: `JobConfig` (`core/sunbird_ai_core/config/job_config.py`),
wrapped by `BaseJobConfig` (`core/sunbird_ai_core/base/base_job_config.py`) which exposes typed
`@property` accessors (`job_name`, `kafka_brokers`, `parallelism`, ...) for settings every job
needs.

## Standard

- **Read config only via `BaseJobConfig`** — a typed `@property` for anything shared across
  jobs (zero-arg, read-only -> `@property`; needs a parameter -> plain method, e.g.
  `kafka_topic(topic_key)`), or `self._config.raw("dotted.key", default)` as the escape hatch
  for job-specific settings `BaseJobConfig` has no reason to know about (e.g.
  `transcription.model`, `multilingual.batch_size`).
- **Never call `yaml.safe_load` or read `config.yaml` directly outside `JobConfig`.**
- **Env-var overrides use the `SUNBIRD_AI_` prefix, not the literal `${VAR}` name shown in
  YAML.** `JobConfig.get("kafka.brokers")` checks `SUNBIRD_AI_KAFKA_BROKERS` (dots -> `_`,
  upper-cased) before falling back to the YAML value. **The `${KAFKA_BROKERS}`-style
  placeholders in `config.yaml` are currently cosmetic only** — nothing in this codebase parses
  or substitutes `${...}` tokens. If you're tempted to "fix" a missing override by setting
  `KAFKA_BROKERS` instead of `SUNBIRD_AI_KAFKA_BROKERS`, that's the exact gotcha this note
  exists to prevent. See `core/docs/01_config.md` for the full writeup, including that this is
  a known, still-open design question (real `${VAR}` substitution vs. rewriting the YAML
  placeholders to show actual env var names) — don't silently "fix" it as a side effect of an
  unrelated change; call it out explicitly if you touch it.
- Env vars always win over the YAML file, unconditionally, for any key.
- Required settings go through `get_required`/`@property` (raises `KeyError` at startup if
  missing); optional settings always pass an explicit default.
