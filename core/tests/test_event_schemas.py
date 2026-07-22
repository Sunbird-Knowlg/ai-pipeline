from sunbird_ai_core.kafka.event_schemas import (
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
