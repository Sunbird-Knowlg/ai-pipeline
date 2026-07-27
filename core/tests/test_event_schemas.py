import datetime
import json

from sunbird_ai_core.kafka.event_schemas import (
    DlqEnvelope,
    EnrichedMetadataEvent,
    MediaMultilingualRequest,
    MediaTranscriptionRequest,
)


def test_enriched_metadata_event_roundtrip():
    raw = (
        '{"id": "do_123", "contentType": "Content", "action": "publish", '
        '"data": {"mimeType": "video/mp4"}}'
    )
    event = EnrichedMetadataEvent.from_json(raw)

    assert event.id == "do_123"
    assert event.contentType == "Content"
    assert event.data["mimeType"] == "video/mp4"

    reparsed = EnrichedMetadataEvent.from_json(event.to_json())
    assert reparsed == event


def test_transcription_request_roundtrip():
    request = MediaTranscriptionRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        transcriptId="do_transcript_1",
        artifactUrl="https://blob/do_123.mp4",
        mimeType="video/mp4",
    )
    reparsed = MediaTranscriptionRequest.from_json(request.to_json())
    assert reparsed == request


def test_multilingual_request_roundtrip():
    request = MediaMultilingualRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        sourceLanguage="en",
        sourceTranscriptUrl="https://blob/en/transcript.json",
        targetLanguages=["hi", "ta"],
    )
    reparsed = MediaMultilingualRequest.from_json(request.to_json())
    assert reparsed == request


def test_transcription_request_from_json_ignores_unknown_fields():
    raw = (
        '{"contentId": "do_123", "enrichmentId": "do_enrich_1", '
        '"transcriptId": "do_transcript_1", "artifactUrl": "https://blob/do_123.mp4", '
        '"mimeType": "video/mp4", "futureField": "added-by-a-newer-producer"}'
    )
    request = MediaTranscriptionRequest.from_json(raw)
    assert request.contentId == "do_123"


def test_multilingual_request_from_json_ignores_unknown_fields():
    raw = (
        '{"contentId": "do_123", "enrichmentId": "do_enrich_1", "sourceLanguage": "en", '
        '"sourceTranscriptUrl": "https://blob/en/transcript.json", "targetLanguages": ["hi"], '
        '"futureField": "added-by-a-newer-producer"}'
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
