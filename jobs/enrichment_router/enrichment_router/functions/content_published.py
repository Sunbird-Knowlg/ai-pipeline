import logging

from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaTranscriptionRequest

_ACTIVE_STATUSES = {"Processing", "Review", "Live"}

logger = logging.getLogger(__name__)


def handle_content_published(
    event: EnrichedMetadataEvent, graph: JanusGraphUtil, mime_types: list[str]
) -> MediaTranscriptionRequest | None:
    """Content published event -> transcription request, or None to skip.

    Skip reasons (all valid, all safe to replay):
      - mimeType not a configured video type
      - no Enrichment node for this content (creator never called transcript create)
      - no source-language Transcript node under the Enrichment
      - source Transcript already Processing/Review/Live
      - source Transcript already has a captionsUrl (creator uploaded VTT manually)
    """
    content_id = event.id
    mime_type = event.data.get("mimeType")

    if mime_type not in mime_types:
        logger.info("Skip %s: mimeType %s not configured for transcription", content_id, mime_type)
        return None

    enrichment = graph.find_by_property("Enrichment", "contentId", content_id)
    if enrichment is None:
        logger.info("Skip %s: no Enrichment node found", content_id)
        return None

    enrichment_id = enrichment["IL_UNIQUE_ID"]
    transcripts = graph.get_related_nodes(enrichment_id, "transcripts", direction="out")
    source_transcript = next((t for t in transcripts if t.get("sourceLanguage") is True), None)
    if source_transcript is None:
        logger.info(
            "Skip %s: no source-language Transcript node under Enrichment %s", content_id, enrichment_id
        )
        return None

    if source_transcript.get("status") in _ACTIVE_STATUSES:
        logger.info(
            "Skip %s: source Transcript already %s", content_id, source_transcript.get("status")
        )
        return None

    if source_transcript.get("captionsUrl"):
        logger.info("Skip %s: source Transcript already has captionsUrl (manual upload)", content_id)
        return None

    return MediaTranscriptionRequest(
        contentId=content_id,
        enrichmentId=enrichment_id,
        transcriptId=source_transcript["IL_UNIQUE_ID"],
        artifactUrl=event.data.get("artifactUrl", ""),
        mimeType=mime_type,
    )
