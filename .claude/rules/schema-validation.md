---
paths:
  - "core/sunbird_ai_core/graph/schema_registry.py"
  - "**/sync.py"
---

# Schema-driven validation, fetched at runtime

- `SchemaRegistry` (`core/sunbird_ai_core/graph/schema_registry.py`) fetches `schema.json` and
  `config.json` per object type (`Enrichment`, `Transcript`, ...) from blob storage over HTTP,
  at runtime, and caches them in-memory for the process lifetime (no TTL/eviction). This
  mirrors the `DefinitionFactory`/`SchemaValidatorFactory` pattern used elsewhere on the
  platform.
- **Do not commit local copies of object schemas into this repo, and do not hardcode field
  lists that schemas already define.** `sync_enrichment_transcripts`
  (`caption_generator/sync.py`) is the canonical example: it calls
  `graph.schema_registry.get_relation_fields("Transcript")` to learn which fields belong in the
  denormalized snapshot, rather than hardcoding a field list — new relation fields added to the
  platform's schema should show up automatically, with no code change here.
- If you need a fallback for object types that predate a schema convention (e.g. missing
  `relationFields` in `config.json`), use `.get(key, [sensible_default])` the way
  `get_relation_fields` already does — don't raise for older schemas that legitimately lack a
  newer field.
- `SchemaRegistry.validate(object_type, payload)` raises `jsonschema.ValidationError` on a
  mismatch — treat that as a real failure to surface (e.g. via the DLQ pattern in
  `kafka-contracts.md`), not something to catch-and-ignore.
