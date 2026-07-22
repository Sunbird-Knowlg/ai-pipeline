from enrichment_router.functions.content_published import handle_content_published

MIME_TYPES = ["video/mp4", "video/webm"]


def test_skips_unconfigured_mime_type(content_published_event, mock_graph):
    content_published_event.data["mimeType"] = "application/pdf"

    result = handle_content_published(content_published_event, mock_graph, MIME_TYPES)

    assert result is None
    mock_graph.find_by_property.assert_not_called()


def test_skips_when_no_enrichment_node(content_published_event, mock_graph):
    mock_graph.find_by_property.return_value = None

    result = handle_content_published(content_published_event, mock_graph, MIME_TYPES)

    assert result is None


def test_skips_when_no_source_transcript(content_published_event, mock_graph):
    mock_graph.find_by_property.return_value = {"IL_UNIQUE_ID": "do_enrich_1"}
    mock_graph.get_related_nodes.return_value = []

    result = handle_content_published(content_published_event, mock_graph, MIME_TYPES)

    assert result is None


def test_skips_when_source_transcript_active(content_published_event, mock_graph):
    mock_graph.find_by_property.return_value = {"IL_UNIQUE_ID": "do_enrich_1"}
    mock_graph.get_related_nodes.return_value = [
        {"IL_UNIQUE_ID": "do_transcript_1", "sourceLanguage": True, "status": "Processing"}
    ]

    result = handle_content_published(content_published_event, mock_graph, MIME_TYPES)

    assert result is None


def test_skips_when_captions_url_already_present(content_published_event, mock_graph):
    mock_graph.find_by_property.return_value = {"IL_UNIQUE_ID": "do_enrich_1"}
    mock_graph.get_related_nodes.return_value = [
        {
            "IL_UNIQUE_ID": "do_transcript_1",
            "sourceLanguage": True,
            "status": "Draft",
            "captionsUrl": "https://blob/captions.vtt",
        }
    ]

    result = handle_content_published(content_published_event, mock_graph, MIME_TYPES)

    assert result is None


def test_emits_transcription_request(content_published_event, mock_graph):
    mock_graph.find_by_property.return_value = {"IL_UNIQUE_ID": "do_enrich_1"}
    mock_graph.get_related_nodes.return_value = [
        {
            "IL_UNIQUE_ID": "do_transcript_1",
            "sourceLanguage": True,
            "status": "Draft",
            "captionsUrl": None,
        }
    ]

    result = handle_content_published(content_published_event, mock_graph, MIME_TYPES)

    assert result is not None
    assert result.contentId == "do_123"
    assert result.enrichmentId == "do_enrich_1"
    assert result.transcriptId == "do_transcript_1"
    assert result.mimeType == "video/mp4"
