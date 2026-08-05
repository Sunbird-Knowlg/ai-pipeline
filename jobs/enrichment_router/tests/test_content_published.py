import requests
from enrichment_router.functions.content_published import handle_content_published

MIME_TYPES = ["video/mp4", "video/webm"]


def _enrichment_response(transcripts, channel="tn"):
    return {
        "result": {
            "enrichment": {
                "identifier": "do_enrich_1",
                "channel": channel,
                "transcripts": transcripts,
            }
        }
    }


def test_skips_unconfigured_mime_type(content_published_event, mock_knowlg):
    content_published_event.data["mimeType"] = "application/pdf"

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is None
    mock_knowlg.get.assert_not_called()


def test_skips_when_no_enrichment_node(content_published_event, mock_knowlg):
    mock_knowlg.get.side_effect = requests.exceptions.HTTPError("400 ERR_NO_ENRICHMENT_FOUND")

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is None


def test_skips_when_no_source_transcript(content_published_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response([])

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is None


def test_skips_when_source_transcript_active(content_published_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [{"identifier": "do_transcript_1", "sourceLanguage": True, "status": "Processing"}]
    )

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is None


def test_skips_when_captions_url_already_present(content_published_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_transcript_1",
                "sourceLanguage": True,
                "status": "Draft",
                "captionsUrl": "https://blob/captions.vtt",
            }
        ]
    )

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is None


def test_emits_transcription_request(content_published_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_transcript_1",
                "sourceLanguage": True,
                "status": "Draft",
                "captionsUrl": None,
            }
        ]
    )

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is not None
    assert result.contentId == "do_123"
    assert result.enrichmentId == "do_enrich_1"
    assert result.transcriptId == "do_transcript_1"
    assert result.mimeType == "video/mp4"
