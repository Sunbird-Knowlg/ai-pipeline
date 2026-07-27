import logging

from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaMultilingualRequest
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient

_INACTIVE_STATUSES = {"Draft", "Failed"}

logger = logging.getLogger(__name__)


def handle_transcript_approved(
    event: EnrichedMetadataEvent,
    graph: JanusGraphUtil,
    knowlg: KnowlgClient,
    configured_languages: list[str],
) -> MediaMultilingualRequest | None:
    """Transcript approved event -> multilingual request, or None to skip.

    Only source-language approvals trigger multilingual. Creates a Draft
    Transcript node (via knowlg platform, for schema validation + relation
    wiring) for every configured language that doesn't already have an
    active node under this Enrichment.
    """
    if not event.data.get("sourceLanguage"):
        logger.info("Skip %s: approval is not for the source language", event.id)
        return None

    if not configured_languages:
        logger.info("Skip %s: no multilingual languages configured", event.id)
        return None

    content_id = event.data["contentId"]
    enrichment_id = event.data["enrichmentId"]

    # "transcripts" is the schema relation *name*, not the JanusGraph edge
    # label — all associatedTo-type relations share the "associatedTo" edge
    # label (see AssociationRelation.getRelationType in knowledge-platform).
    existing_transcripts = graph.get_related_nodes(enrichment_id, "associatedTo", direction="out")
    active_languages = {
        t["languageCode"]
        for t in existing_transcripts
        if t.get("status") not in _INACTIVE_STATUSES and not t.get("sourceLanguage")
    }

    target_languages = [lang for lang in configured_languages if lang not in active_languages]
    if not target_languages:
        logger.info("Skip %s: all configured languages already active", event.id)
        return None

    for language_code in target_languages:
        knowlg.post(
            "transcript_create",
            {
                "request": {
                    "transcript": {
                        "contentId": content_id,
                        "enrichmentId": enrichment_id,
                        "languageCode": language_code,
                        "sourceLanguage": False,
                    }
                }
            },
        )

    source_transcript = next(
        (t for t in existing_transcripts if t.get("sourceLanguage") is True), None
    )
    source_transcript_url = source_transcript.get("artifactUrl", "") if source_transcript else ""

    return MediaMultilingualRequest(
        contentId=content_id,
        enrichmentId=enrichment_id,
        sourceLanguage=event.data.get("languageCode", ""),
        sourceTranscriptUrl=source_transcript_url,
        targetLanguages=target_languages,
        channel=event.data.get("channel", ""),
    )
