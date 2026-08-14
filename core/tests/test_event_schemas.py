import datetime
import json

from sunbird_ai_core.kafka.event_schemas import (
    DlqEnvelope,
    EnrichedMetadataEvent,
    MediaMultilingualRequest,
    MediaTranscriptionRequest,
)


def test_enriched_metadata_event_roundtrip():
    raw = json.dumps(
        {
            "eid": "BE_JOB_REQUEST",
            "ets": 1234567890,
            "mid": "LP.1234567890.abc",
            "actor": {"id": "knowlg-service", "type": "System"},
            "context": {
                "pdata": {"ver": "1.0", "id": "org.ekstep.platform"},
                "channel": "in.ekstep",
                "env": "dev",
            },
            "object": {"ver": "1.0", "id": "do_123"},
            "edata": {"action": "publish", "contentType": "Content", "mimeType": "video/mp4"},
        }
    )
    event = EnrichedMetadataEvent.from_json(raw)

    assert event.id == "do_123"
    assert event.contentType == "Content"
    assert event.action == "publish"
    assert event.data["mimeType"] == "video/mp4"
    assert event.data["channel"] == "in.ekstep"

    reparsed = EnrichedMetadataEvent.from_json(event.to_json())
    assert reparsed == event


def test_enriched_metadata_event_accepts_legacy_flat_shape():
    """Old producers (not yet migrated to the BE_JOB_REQUEST envelope) must
    keep working during a rolling deploy."""
    raw = (
        '{"id": "do_123", "contentType": "Content", "action": "publish", '
        '"data": {"mimeType": "video/mp4"}}'
    )
    event = EnrichedMetadataEvent.from_json(raw)

    assert event.id == "do_123"
    assert event.contentType == "Content"
    assert event.data["mimeType"] == "video/mp4"


def test_enriched_metadata_event_to_json_uses_standard_envelope():
    event = EnrichedMetadataEvent(
        id="do_123", contentType="Content", action="publish", data={"mimeType": "video/mp4"}
    )

    payload = json.loads(event.to_json())

    assert payload["eid"] == "BE_JOB_REQUEST"
    assert payload["object"]["id"] == "do_123"
    assert payload["edata"]["action"] == "publish"
    assert payload["edata"]["contentType"] == "Content"
    assert payload["edata"]["mimeType"] == "video/mp4"
    assert "mid" in payload and "ets" in payload
    assert payload["context"]["env"] == ""


def test_enriched_metadata_event_to_json_forwards_env():
    # Regression: to_json() previously had no env param at all, so any
    # producer emitting EnrichedMetadataEvent could not stamp context.env,
    # unlike MediaTranscriptionRequest/MediaMultilingualRequest.to_json.
    event = EnrichedMetadataEvent(id="do_123", contentType="Content", action="publish")

    payload = json.loads(event.to_json(env="dev"))

    assert payload["context"]["env"] == "dev"


def test_enriched_metadata_event_to_json_also_carries_flat_top_level_shape():
    # dev.knowlg.enriched.content.metadata is shared with content-embedding-job,
    # which parses a flat {id, contentType, _schema_version, data} shape and
    # throws on a missing top-level "id" — these siblings must be present
    # alongside our own envelope, and "data" must be absent so their chunking
    # stage filters the event instead of trying to embed our metadata.
    event = EnrichedMetadataEvent(
        id="do_123", contentType="Transcript", action="approved", data={"languageCode": "en"}
    )

    payload = json.loads(event.to_json())

    assert payload["id"] == "do_123"
    assert payload["contentType"] == "Transcript"
    assert payload["_schema_version"] == "1.0"
    assert "data" not in payload


def test_transcription_request_roundtrip():
    request = MediaTranscriptionRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        transcriptId="do_transcript_1",
        artifactUrl="https://blob/do_123.mp4",
        mimeType="video/mp4",
        channel="in.ekstep",
    )
    reparsed = MediaTranscriptionRequest.from_json(request.to_json())
    assert reparsed == request


def test_transcription_request_to_json_uses_standard_envelope():
    request = MediaTranscriptionRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        transcriptId="do_transcript_1",
        artifactUrl="https://blob/do_123.mp4",
        mimeType="video/mp4",
        channel="in.ekstep",
    )

    payload = json.loads(request.to_json(env="dev"))

    assert payload["eid"] == "BE_JOB_REQUEST"
    assert payload["object"]["id"] == "do_123"
    assert payload["context"]["channel"] == "in.ekstep"
    assert payload["context"]["env"] == "dev"
    assert payload["edata"]["action"] == "media-transcription-request"
    assert payload["edata"]["contentId"] == "do_123"
    assert payload["edata"]["transcriptId"] == "do_transcript_1"
    assert "channel" not in payload["edata"]


def test_multilingual_request_roundtrip():
    request = MediaMultilingualRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        sourceLanguage="en",
        sourceTranscriptUrl="https://blob/en/transcript.json",
        targetLanguages=["hi", "ta"],
        channel="in.ekstep",
    )
    reparsed = MediaMultilingualRequest.from_json(request.to_json())
    assert reparsed == request


def test_multilingual_request_to_json_uses_standard_envelope():
    request = MediaMultilingualRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        sourceLanguage="en",
        sourceTranscriptUrl="https://blob/en/transcript.json",
        targetLanguages=["hi", "ta"],
    )

    payload = json.loads(request.to_json())

    assert payload["edata"]["action"] == "media-multilingual-request"
    assert payload["edata"]["targetLanguages"] == ["hi", "ta"]


def test_transcription_request_from_json_ignores_unknown_edata_fields():
    raw = json.dumps(
        {
            "eid": "BE_JOB_REQUEST",
            "ets": 1,
            "mid": "LP.1.abc",
            "actor": {"id": "enrichment-router", "type": "System"},
            "context": {"pdata": {"ver": "1.0", "id": "org.ekstep.platform"}, "channel": "", "env": ""},
            "object": {"ver": "1.0", "id": "do_123"},
            "edata": {
                "action": "media-transcription-request",
                "contentId": "do_123",
                "enrichmentId": "do_enrich_1",
                "transcriptId": "do_transcript_1",
                "artifactUrl": "https://blob/do_123.mp4",
                "mimeType": "video/mp4",
                "futureField": "added-by-a-newer-producer",
            },
        }
    )
    request = MediaTranscriptionRequest.from_json(raw)
    assert request.contentId == "do_123"


def test_multilingual_request_from_json_ignores_unknown_edata_fields():
    raw = json.dumps(
        {
            "eid": "BE_JOB_REQUEST",
            "ets": 1,
            "mid": "LP.1.abc",
            "actor": {"id": "enrichment-router", "type": "System"},
            "context": {"pdata": {"ver": "1.0", "id": "org.ekstep.platform"}, "channel": "", "env": ""},
            "object": {"ver": "1.0", "id": "do_123"},
            "edata": {
                "action": "media-multilingual-request",
                "contentId": "do_123",
                "enrichmentId": "do_enrich_1",
                "sourceLanguage": "en",
                "sourceTranscriptUrl": "https://blob/en/transcript.json",
                "targetLanguages": ["hi"],
                "futureField": "added-by-a-newer-producer",
            },
        }
    )
    request = MediaMultilingualRequest.from_json(raw)
    assert request.sourceLanguage == "en"


def test_dlq_envelope_to_json_handles_non_json_native_values():
    envelope = DlqEnvelope(
        originalEvent={"receivedAt": datetime.datetime(2026, 1, 1)},
        errorMessage="boom",
        jobName="enrichment-router",
    )

    payload = json.loads(envelope.to_json())

    assert payload["originalEvent"]["receivedAt"] == "2026-01-01 00:00:00"
