import logging

from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.identifiers import generate_identifier
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaMultilingualRequest
from sunbird_ai_core.languages import language_name

_INACTIVE_STATUSES = {"Draft", "Failed"}

logger = logging.getLogger(__name__)


def handle_transcript_approved(
    event: EnrichedMetadataEvent,
    graph: JanusGraphUtil,
    configured_languages: list[str],
) -> MediaMultilingualRequest | None:
    """Transcript approved event -> multilingual request, or None to skip.

    Only source-language approvals trigger multilingual. Creates a Draft
    Transcript node directly via JanusGraph (mirroring
    TranscriptManager.createTranscriptChildNode in knowledge-platform) for
    every configured language that doesn't already have an active node
    under this Enrichment.

    knowlg's own POST /content/v4/transcript/create/:identifier can't be
    used for this — that endpoint is hardwired for (re)generating the
    *source* transcript (requires the content's own artifactUrl/mimeType,
    always creates with sourceLanguage=true); there's no knowlg API for
    "create a Draft transcript for a specific target language" today.
    """
    if not event.data.get("sourceLanguage"):
        logger.info("Skip %s: approval is not for the source language", event.id)
        return None

    if not configured_languages:
        logger.info("Skip %s: no multilingual languages configured", event.id)
        return None

    content_id = event.data["contentId"]
    enrichment_id = event.data["enrichmentId"]
    source_language_code = event.data.get("languageCode", "")

    # "transcripts" is the schema relation *name*, not the JanusGraph edge
    # label — all associatedTo-type relations share the "associatedTo" edge
    # label (see AssociationRelation.getRelationType in knowledge-platform).
    existing_transcripts = graph.get_related_nodes(enrichment_id, "associatedTo", direction="out")
    active_languages = {
        t["languageCode"]
        for t in existing_transcripts
        if t.get("status") not in _INACTIVE_STATUSES and not t.get("sourceLanguage")
    }

    # Excludes the source's own language explicitly — active_languages only
    # tracks non-source transcripts, so without this a configured_languages
    # list that happens to include the source language (e.g. source is
    # English and "en" is also in the configured target list) would create
    # a duplicate transcript for a language that's already done.
    target_languages = [
        lang for lang in configured_languages if lang not in active_languages and lang != source_language_code
    ]
    if not target_languages:
        logger.info("Skip %s: all configured languages already active", event.id)
        return None

    channel = event.data.get("channel", "")
    for language_code in target_languages:
        transcript_id = generate_identifier()
        graph.create_node(
            "Transcript",
            transcript_id,
            {
                "name": f"Transcript_{transcript_id}",
                "code": transcript_id,
                "channel": channel,
                "languageCode": language_code,
                "language": language_name(language_code),
                "sourceLanguage": False,
                "status": "Draft",
            },
        )
        graph.create_relation(enrichment_id, transcript_id, "associatedTo")

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
