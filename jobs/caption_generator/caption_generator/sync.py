from datetime import datetime, timezone

from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil


def sync_enrichment_transcripts(graph: JanusGraphUtil, enrichment_id: str) -> list[dict]:
    """Denormalizes all Transcript nodes under an Enrichment into
    Enrichment.transcripts, filtered to the relationFields declared in
    Transcript's config.json. Returns the raw (unfiltered) transcript nodes
    so callers can still check identifiers/status directly.
    """
    relation_fields = graph.schema_registry.get_relation_fields("Transcript")
    # "transcripts" is the schema relation *name*, not the JanusGraph edge
    # label — all associatedTo-type relations share the "associatedTo" edge
    # label (see AssociationRelation.getRelationType in knowledge-platform).
    transcripts = graph.get_related_nodes(enrichment_id, "associatedTo", direction="out")

    snapshot = [{field: t.get(field) for field in relation_fields} for t in transcripts]

    graph.update_node(
        enrichment_id,
        {
            "transcripts": snapshot,
            "lastUpdatedOn": datetime.now(timezone.utc).isoformat(),
        },
    )
    return transcripts


_BLOCKING_STATUSES = {"Draft", "Review", "Processing"}


def is_ecar_ready(transcripts: list[dict], allow_failed_languages: bool = True) -> bool:
    """Source language must be Live. Every other language must not be
    Draft/Review/Processing (still in flight or awaiting approval) — Failed
    is allowed to pass through (ECAR is built from whatever succeeded) unless
    allow_failed_languages is False, in which case a Failed language blocks
    generation the same way an in-flight one does.
    """
    if not transcripts:
        return False

    source = next((t for t in transcripts if t.get("sourceLanguage") is True), None)
    if source is None or source.get("status") != "Live":
        return False

    for transcript in transcripts:
        if transcript.get("sourceLanguage") is True:
            continue
        status = transcript.get("status")
        if status in _BLOCKING_STATUSES:
            return False
        if status == "Failed" and not allow_failed_languages:
            return False

    return True
