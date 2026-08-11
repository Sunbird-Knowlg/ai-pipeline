import logging

from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaMultilingualRequest
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient
from sunbird_ai_core.languages import language_name

_INACTIVE_STATUSES = {"Draft", "Failed"}

logger = logging.getLogger(__name__)


def handle_transcript_approved(
    event: EnrichedMetadataEvent,
    knowlg: KnowlgClient,
    configured_languages: list[str],
) -> MediaMultilingualRequest | None:
    """Transcript approved event -> multilingual request, or None to skip.

    Only source-language approvals trigger multilingual. For every configured
    language that doesn't already have an active Transcript node under this
    content's Enrichment, calls knowlg's generic POST /content/v4/object/create
    API to create a target-language Draft Transcript (server-side, via
    TranscriptManager.createTargetDraft in knowledge-platform).

    This replaces the direct JanusGraph node/relation writes this job used to
    make for the same purpose — knowlg's object/create dispatch now handles
    that Draft creation itself (idempotently: calling it again for a language
    that already has a Transcript just returns the existing one), so this job
    no longer needs to construct identifiers, edges, or schema metadata by
    hand.

    Args:
        event: The Transcript-approved enriched.metadata event.
        knowlg: Knowlg HTTP client for reading Enrichment state and creating
            target-language Transcript nodes.
        configured_languages: The full list of target languages this
            deployment should generate multilingual transcripts for.

    Returns:
        A MediaMultilingualRequest naming the target languages that still
        need translation, or None if the event should be skipped.
    """
    content_id = event.data.get("contentId", "")
    extra = {"content_id": content_id, "event_id": event.id}
    logger.info("Evaluating transcript-approved event", extra=extra)

    if not event.data.get("sourceLanguage"):
        logger.info("Skip: approval is not for the source language", extra=extra)
        return None
    logger.info("Approval is for the source language", extra=extra)

    if not configured_languages:
        logger.info("Skip: no multilingual languages configured", extra=extra)
        return None

    enrichment_id = event.data["enrichmentId"]
    source_language_code = event.data.get("languageCode", "")
    extra["enrichment_id"] = enrichment_id

    logger.info("Reading Enrichment state", extra=extra)
    response = knowlg.get("enrichment_read", identifier=content_id)
    enrichment = response.get("result", {}).get("enrichment", {})
    existing_transcripts = enrichment.get("transcripts", [])
    active_languages = {
        t["languageCode"]
        for t in existing_transcripts
        if t.get("status") not in _INACTIVE_STATUSES and not t.get("sourceLanguage")
    }
    logger.info("Computed active languages", extra={**extra, "active_languages": list(active_languages)})

    # Excludes the source's own language explicitly, since active_languages
    # only tracks non-source transcripts and could otherwise re-create one.
    target_languages = [
        lang for lang in configured_languages if lang not in active_languages and lang != source_language_code
    ]
    if not target_languages:
        logger.info("Skip: all configured languages already active", extra=extra)
        return None
    logger.info("Computed target languages", extra={**extra, "target_languages": target_languages})

    for language_code in target_languages:
        logger.info("Creating target-language Transcript draft", extra={**extra, "language_code": language_code})
        knowlg.post(
            "object_create",
            {
                "objectType": "Transcript",
                "languageCode": language_code,
                "language": language_name(language_code),
            },
            identifier=content_id,
        )
        logger.info("Created target-language Transcript draft", extra={**extra, "language_code": language_code})

    source_transcript = next(
        (t for t in existing_transcripts if t.get("sourceLanguage") is True), None
    )
    source_transcript_url = source_transcript.get("artifactUrl", "") if source_transcript else ""

    logger.info(
        "Dispatching multilingual request",
        extra={**extra, "target_languages": target_languages},
    )
    return MediaMultilingualRequest(
        contentId=content_id,
        enrichmentId=enrichment_id,
        sourceLanguage=event.data.get("languageCode", ""),
        sourceTranscriptUrl=source_transcript_url,
        targetLanguages=target_languages,
        channel=event.data.get("channel", ""),
    )
