from unittest.mock import Mock

import pytest
from caption_generator.segment import Segment
from sunbird_ai_core.kafka.event_schemas import MediaMultilingualRequest, MediaTranscriptionRequest


@pytest.fixture
def mock_knowlg():
    return Mock()


@pytest.fixture
def mock_storage():
    storage = Mock()
    storage.get_uri.side_effect = lambda key: f"az://test-container/{key}"
    return storage


@pytest.fixture
def mock_transcription_provider():
    provider = Mock()
    provider.transcribe.return_value = (
        [
            Segment(id=0, start=0.0, end=2.5, text="Hello children"),
            Segment(id=1, start=2.5, end=5.0, text="Welcome to the lesson"),
        ],
        [
            Segment(id=0, start=0.0, end=0.5, text="Hello"),
            Segment(id=1, start=0.5, end=2.5, text="children"),
            Segment(id=2, start=2.5, end=2.8, text="Welcome"),
            Segment(id=3, start=2.8, end=3.2, text="to"),
            Segment(id=4, start=3.2, end=3.6, text="the"),
            Segment(id=5, start=3.6, end=5.0, text="lesson"),
        ],
        "en",
    )
    return provider


@pytest.fixture
def sample_segments():
    return [
        Segment(id=0, start=0.0, end=2.5, text="Hello children"),
        Segment(id=1, start=2.5, end=5.0, text="Welcome to the lesson"),
    ]


@pytest.fixture
def transcription_request():
    return MediaTranscriptionRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        transcriptId="do_transcript_1",
        artifactUrl="https://blob/do_123.mp4",
        mimeType="video/mp4",
    )


@pytest.fixture
def multilingual_request():
    return MediaMultilingualRequest(
        contentId="do_123",
        enrichmentId="do_enrich_1",
        sourceLanguage="en",
        sourceTranscriptUrl="az://test-container/content/do_123/transcripts/en/transcript.json",
        targetLanguages=["hi", "ta"],
    )
