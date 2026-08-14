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


def test_skips_when_human_caption_already_present(content_published_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_transcript_1",
                "sourceLanguage": True,
                "status": "Draft",
                "captionsUrl": "https://blob/captions.vtt",
                "generatedBy": "human-uploaded",
            }
        ]
    )

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is None


def test_does_not_skip_ai_generated_captions(content_published_event, mock_knowlg):
    # A Draft/Review source transcript that already has AI-generated
    # captions (generatedBy is the provider name, not human-*) must not be
    # treated the same as a protected human upload.
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_transcript_1",
                "sourceLanguage": True,
                "status": "Draft",
                "captionsUrl": "https://blob/captions.vtt",
                "generatedBy": "faster_whisper:large-v3-turbo",
            }
        ]
    )

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is not None


def _mock_get(enrichment_transcripts, content_last_updated):
    def get(api_key, **kwargs):
        if api_key == "content_read":
            return {"result": {"content": {"lastUpdatedOn": content_last_updated}}}
        return _enrichment_response(enrichment_transcripts)

    return get


def test_republish_bypasses_active_skip(content_published_event, mock_knowlg):
    mock_knowlg.get.side_effect = _mock_get(
        [
            {
                "identifier": "do_transcript_1",
                "sourceLanguage": True,
                "status": "Live",
                "captionsUrl": "https://blob/captions.vtt",
                "generatedBy": "faster_whisper:large-v3-turbo",
                "lastUpdatedOn": "2026-08-14T07:00:00.000+0000",
            }
        ],
        content_last_updated="2026-08-14T08:00:00.000+0000",
    )

    result = handle_content_published(content_published_event, mock_knowlg, MIME_TYPES)

    assert result is not None
    assert result.isRepublish is True


def test_skips_active_when_not_a_republish(content_published_event, mock_knowlg):
    mock_knowlg.get.side_effect = _mock_get(
        [
            {
                "identifier": "do_transcript_1",
                "sourceLanguage": True,
                "status": "Live",
                "captionsUrl": "https://blob/captions.vtt",
                "generatedBy": "faster_whisper:large-v3-turbo",
                "lastUpdatedOn": "2026-08-14T08:00:00.000+0000",
            }
        ],
        content_last_updated="2026-08-14T07:00:00.000+0000",
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
