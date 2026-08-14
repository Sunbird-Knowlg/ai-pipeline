import logging
from datetime import datetime

import requests
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaTranscriptionRequest
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient

_ACTIVE_STATUSES = {"Processing", "Review", "Live"}
_HUMAN_GENERATED_BY = {"human-edited", "human-uploaded"}

logger = logging.getLogger(__name__)


def _parse_timestamp(value: str) -> datetime | None:
    """Parses a knowlg lastUpdatedOn-style ISO 8601 timestamp.

    Returns None (rather than raising) for a missing/malformed value, so a
    republish check that can't compare timestamps safely falls back to "not
    a republish" instead of crashing the event.
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


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

    is_republish = False
    if source_transcript.get("status") in _ACTIVE_STATUSES:
        # A republish (content edited after this transcript was last
        # generated) must still go through, even though status looks
        # "done" — otherwise a Live transcript can never be regenerated
        # short of a manual reject/reset. Reads the Content node directly
        # rather than relying on the publish event's own (configurable,
        # easy-to-miss) field allow-list.
        try:
            content_response = knowlg.get("content_read", identifier=content_id)
        except requests.exceptions.RequestException:
            logger.info("Skip: could not read Content node to check for republish", extra=extra)
            return None
        content_last_updated = _parse_timestamp(
            content_response.get("result", {}).get("content", {}).get("lastUpdatedOn", "")
        )
        transcript_last_updated = _parse_timestamp(source_transcript.get("lastUpdatedOn", ""))
        is_republish = bool(
            content_last_updated
            and transcript_last_updated
            and content_last_updated > transcript_last_updated
        )
        if not is_republish:
            logger.info(
                "Skip: source Transcript already active",
                extra={**extra, "status": source_transcript.get("status")},
            )
            return None
        logger.info(
            "Republish detected (content updated after transcript) — regenerating despite active status",
            extra={
                **extra,
                "status": source_transcript.get("status"),
                "content_last_updated": str(content_last_updated),
                "transcript_last_updated": str(transcript_last_updated),
            },
        )
    else:
        logger.info("Source Transcript not active", extra=extra)

    # Only a human-authored caption is protected from being overwritten — an
    # AI-generated one (the normal Live/Review case) always has captionsUrl
    # set too, so this must not block the republish path above.
    if source_transcript.get("captionsUrl") and source_transcript.get("generatedBy") in _HUMAN_GENERATED_BY:
        logger.info("Skip: source Transcript already has a human caption", extra=extra)
        return None
    logger.info("No manual captionsUrl present", extra=extra)

    logger.info(
        "Dispatching transcription request",
        extra={**extra, "transcript_id": source_transcript["identifier"], "is_republish": is_republish},
    )
    return MediaTranscriptionRequest(
        contentId=content_id,
        enrichmentId=enrichment_id,
        transcriptId=source_transcript["identifier"],
        artifactUrl=event.data.get("artifactUrl", ""),
        mimeType=mime_type,
        channel=enrichment.get("channel", ""),
        isRepublish=is_republish,
    )
