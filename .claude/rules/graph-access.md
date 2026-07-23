---
paths:
  - "core/sunbird_ai_core/graph/**"
  - "**/functions/**.py"
  - "**/sync.py"
---

# JanusGraph access

- **All graph access goes through `JanusGraphUtil`** (`core/sunbird_ai_core/graph/janusgraph_util.py`),
  a thin gremlinpython wrapper — one connection per TaskManager, opened in `open()` and closed
  in `close()` (see `base-class-pattern.md`). Never construct a `DriverRemoteConnection` or
  build raw Gremlin traversals anywhere outside this file.
- **`enrichment-router` is read-only against the graph.** It only calls `get_node`,
  `find_by_property`, `get_related_nodes`, `node_exists` — never `update_node`. If you find
  yourself wanting to write to the graph from `enrichment_router/`, that's a signal the change
  belongs in `caption-generator` instead, or should go through the knowlg content API (an HTTP
  call, not a direct graph write) the way Draft-Transcript-node creation already does in
  `transcript_approved.py`.
- **`caption-generator` is the only job that calls `update_node`.** Every write there also goes
  through `sync_enrichment_transcripts` (`caption_generator/sync.py`) afterward to refresh the
  Enrichment node's denormalized `transcripts` snapshot — don't update a Transcript node's
  status/URLs without also calling `sync_enrichment_transcripts` for its parent Enrichment.
- `update_node` JSON-serializes `list`/`dict` property values automatically (JanusGraph vertex
  properties are scalar-only) — anything reading such a property back must `json.loads()` it;
  this is a convention enforced by discipline, not by the type system.
- Vertex properties always come back from Gremlin as single-element lists; `JanusGraphUtil`'s
  internal `_flatten` unwraps them — don't re-implement that unwrapping in calling code.
