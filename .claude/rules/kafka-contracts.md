---
paths:
  - "**/functions/**.py"
  - "core/sunbird_ai_core/kafka/**"
  - "**/main.py"
---

# Kafka topic contracts, side outputs, and DLQ

- Every Kafka message shape is a `@dataclass` in `core/sunbird_ai_core/kafka/event_schemas.py`
  (`EnrichedMetadataEvent`, `MediaTranscriptionRequest`, `MediaMultilingualRequest`,
  `DlqEnvelope`), each with `to_json()`/`from_json()`. **Add new message shapes here, not as
  ad-hoc dicts** — every producer/consumer should serialize/deserialize through one of these
  dataclasses.
- **Topic contracts** (see each job's `config.yaml` under `kafka.topics`):
  - `enrichment-router`: reads `enriched.metadata`; writes `media.transcription.request` and
    `media.multilingual.request`. Has no DLQ of its own today — a routing failure (bad JSON,
    unrecognized action) is logged and the event dropped, not replayed or queued anywhere.
  - `caption-generator`: reads both of those (merged via `.union()` in `main.py`, then
    discriminated by `EventRouter` on the BE_JOB_REQUEST envelope's `edata.action` —
    `media-transcription-request` vs `media-multilingual-request`, not by payload shape);
    writes `media.transcription.dlq` and `media.multilingual.dlq`.
- **Side outputs (`OutputTag` + `yield (tag, value)`, not `ctx.output()`) are how one
  `ProcessFunction` reaches more than one downstream destination** — PyFlink 1.20's
  `ProcessFunction.Context` has no `.output()` method. `OutputTag` instances are module-level
  constants, imported by both the function that emits to them and the `main.py` that later
  calls `.get_side_output(tag)` — always reuse the same shared instance rather than
  constructing a second `OutputTag` with the same string name (they're matched by
  identity/name; a duplicate instance risks subtle bugs).
- **`caption-generator`'s failure path routes to a DLQ side output** via
  `BaseProcessFunction.emit_to_dlq`, called inside a deliberately broad `except Exception:` at
  the per-element processing boundary — mark the relevant Transcript node `Failed` via
  `knowlg.patch(...)` first, then `yield from self.emit_to_dlq(...)`. `enrichment-router`'s
  `RouterFunction` does not follow this pattern today — it logs and drops a failed event
  instead (see its own docstring for why); don't assume every process function in this repo
  has a DLQ just because `caption-generator`'s do.
- New request/response shapes: prefer the generic `cls(**json.loads(raw))` dict-unpacking
  shortcut in `from_json` only when every field is genuinely required and JSON keys are
  trusted to match exactly; spell out fields individually with `.get(key, default)` fallbacks
  (like `EnrichedMetadataEvent.from_json`) when some fields may legitimately be absent.
