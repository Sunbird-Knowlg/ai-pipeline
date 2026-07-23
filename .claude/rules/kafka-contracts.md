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
    `media.multilingual.request`.
  - `caption-generator`: reads both of those (merged via `.union()` in `main.py`, then
    discriminated structurally by `EventRouter` — presence of `targetLanguages` means
    multilingual); writes `media.transcription.dlq` and `media.multilingual.dlq`.
- **Side outputs (`OutputTag` + `ctx.output(tag, value)`) are how one `ProcessFunction` reaches
  more than one downstream destination.** `OutputTag` instances are module-level constants,
  imported by both the function that emits to them and the `main.py` that later calls
  `.get_side_output(tag)` — always reuse the same shared instance rather than constructing a
  second `OutputTag` with the same string name (they're matched by identity/name; a duplicate
  instance risks subtle bugs).
- **Every failure path routes to a DLQ side output**, via `BaseProcessFunction.emit_to_dlq` —
  mark the relevant graph node `Failed` first, then call `emit_to_dlq`, inside a deliberately
  broad `except Exception:` at the per-element processing boundary (this breadth is
  intentional here: any exception at this boundary should produce the same outcome, not a
  crashed TaskManager — see `core/docs/06_base_classes.md` / `caption_generator/docs/03_*.md`
  for the reasoning). Don't swallow exceptions without both marking the node `Failed` and
  emitting to DLQ.
- New request/response shapes: prefer the generic `cls(**json.loads(raw))` dict-unpacking
  shortcut in `from_json` only when every field is genuinely required and JSON keys are
  trusted to match exactly; spell out fields individually with `.get(key, default)` fallbacks
  (like `EnrichedMetadataEvent.from_json`) when some fields may legitimately be absent.
