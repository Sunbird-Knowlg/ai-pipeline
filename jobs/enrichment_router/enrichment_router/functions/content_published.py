import logging

import requests
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaTranscriptionRequest
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient

_ACTIVE_STATUSES = {"Processing", "Review", "Live"}

logger = logging.getLogger(__name__)


def handle_content_published(
    event: EnrichedMetadataEvent, knowlg: KnowlgClient, mime_types: list[str]
) -> MediaTranscriptionRequest | None:
    """Converts a content published event to a transcription request if conditions are met.

    Checks whether the content has a video mime type, has an Enrichment node with a
    source-language Transcript node, and that Transcript is not already actively being
    processed or manually captioned. Skips if any of these conditions are unmet — all skip
    reasons are valid and safe to replay.

    Args:
        event: The enriched metadata event from the published content.
        knowlg: Knowlg HTTP client for reading the content's Enrichment/Transcript state.
        mime_types: List of configured video mime types that should trigger transcription.

    Returns:
        A MediaTranscriptionRequest populated with content/enrichment/transcript IDs and
        metadata, or None if the event should be skipped.
    """
    content_id = event.id
    mime_type = event.data.get("mimeType")
    extra = {"content_id": content_id, "mime_type": mime_type}
    logger.info("Evaluating content-published event", extra=extra)

    if mime_type not in mime_types:
        logger.info("Skip: mimeType not configured for transcription", extra=extra)
        return None
    logger.info("mimeType eligible for transcription", extra=extra)

    # knowlg's enrichment/read raises a client error (ERR_NO_ENRICHMENT_FOUND)
    # rather than returning an empty body when the content has no Enrichment
    # node yet (creator never called object/create) — treated the same as
    # any other skip: safe to replay once the content does have one.
    logger.info("Reading Enrichment node", extra=extra)
    try:
        response = knowlg.get("enrichment_read", identifier=content_id)
    except requests.exceptions.RequestException:
        logger.info("Skip: no Enrichment node found", extra=extra)
        return None
    enrichment = response.get("result", {}).get("enrichment")
    if enrichment is None:
        logger.info("Skip: no Enrichment node found", extra=extra)
        return None

    enrichment_id = enrichment["identifier"]
    extra["enrichment_id"] = enrichment_id
    logger.info("Found Enrichment node", extra=extra)
    transcripts = enrichment.get("transcripts", [])
    source_transcript = next((t for t in transcripts if t.get("sourceLanguage") is True), None)
    if source_transcript is None:
        logger.info("Skip: no source-language Transcript node under Enrichment", extra=extra)
        return None

    if source_transcript.get("status") in _ACTIVE_STATUSES:
        logger.info("Skip: source Transcript already active", extra={**extra, "status": source_transcript.get("status")})
        return None
    logger.info("Source Transcript not active", extra=extra)

    if source_transcript.get("captionsUrl"):
        logger.info("Skip: source Transcript already has captionsUrl (manual upload)", extra=extra)
        return None
    logger.info("No manual captionsUrl present", extra=extra)

    logger.info(
        "Dispatching transcription request",
        extra={**extra, "transcript_id": source_transcript["identifier"]},
    )
    return MediaTranscriptionRequest(
        contentId=content_id,
        enrichmentId=enrichment_id,
        transcriptId=source_transcript["identifier"],
        artifactUrl=event.data.get("artifactUrl", ""),
        mimeType=mime_type,
        channel=enrichment.get("channel", ""),
    )
