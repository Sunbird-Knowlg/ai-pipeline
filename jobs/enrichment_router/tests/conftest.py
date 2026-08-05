from unittest.mock import Mock

import pytest
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent


@pytest.fixture
def mock_knowlg():
    return Mock()


@pytest.fixture
def content_published_event():
    return EnrichedMetadataEvent(
        id="do_123",
        contentType="Content",
        action="publish",
        data={"mimeType": "video/mp4", "artifactUrl": "https://blob/do_123.mp4"},
    )


@pytest.fixture
def transcript_approved_event():
    return EnrichedMetadataEvent(
        id="do_transcript_1",
        contentType="Transcript",
        action="approved",
        data={
            "contentId": "do_123",
            "enrichmentId": "do_enrich_1",
            "sourceLanguage": True,
            "languageCode": "en",
        },
    )
