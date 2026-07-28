from enrichment_router.functions.transcript_approved import handle_transcript_approved

LANGUAGES = ["hi", "ta"]


def test_skips_non_source_language_approval(transcript_approved_event, mock_graph, mock_knowlg):
    transcript_approved_event.data["sourceLanguage"] = False

    result = handle_transcript_approved(transcript_approved_event, mock_graph, mock_knowlg, LANGUAGES)

    assert result is None
    mock_graph.get_related_nodes.assert_not_called()


def test_skips_when_no_languages_configured(transcript_approved_event, mock_graph, mock_knowlg):
    result = handle_transcript_approved(transcript_approved_event, mock_graph, mock_knowlg, [])

    assert result is None


def test_skips_when_all_languages_already_active(transcript_approved_event, mock_graph, mock_knowlg):
    mock_graph.get_related_nodes.return_value = [
        {"IL_UNIQUE_ID": "do_t_en", "languageCode": "en", "sourceLanguage": True, "status": "Live"},
        {"IL_UNIQUE_ID": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Review"},
        {"IL_UNIQUE_ID": "do_t_ta", "languageCode": "ta", "sourceLanguage": False, "status": "Processing"},
    ]

    result = handle_transcript_approved(transcript_approved_event, mock_graph, mock_knowlg, LANGUAGES)

    assert result is None
    mock_knowlg.post.assert_not_called()


def test_creates_drafts_and_emits_for_new_languages(transcript_approved_event, mock_graph, mock_knowlg):
    mock_graph.get_related_nodes.return_value = [
        {
            "IL_UNIQUE_ID": "do_t_en",
            "languageCode": "en",
            "sourceLanguage": True,
            "status": "Live",
            "artifactUrl": "https://blob/en/transcript.json",
        },
        {"IL_UNIQUE_ID": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Failed"},
    ]

    result = handle_transcript_approved(transcript_approved_event, mock_graph, mock_knowlg, LANGUAGES)

    assert result is not None
    assert set(result.targetLanguages) == {"hi", "ta"}
    assert result.sourceTranscriptUrl == "https://blob/en/transcript.json"
    assert result.contentId == "do_123"
    assert result.enrichmentId == "do_enrich_1"
    assert mock_knowlg.post.call_count == 2


def test_creates_only_missing_languages(transcript_approved_event, mock_graph, mock_knowlg):
    mock_graph.get_related_nodes.return_value = [
        {
            "IL_UNIQUE_ID": "do_t_en",
            "languageCode": "en",
            "sourceLanguage": True,
            "status": "Live",
            "artifactUrl": "https://blob/en/transcript.json",
        },
        {"IL_UNIQUE_ID": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Review"},
    ]

    result = handle_transcript_approved(transcript_approved_event, mock_graph, mock_knowlg, LANGUAGES)

    assert result.targetLanguages == ["ta"]
    mock_knowlg.post.assert_called_once()


def test_excludes_source_language_from_targets(transcript_approved_event, mock_graph, mock_knowlg):
    # Source is "en" (see conftest's transcript_approved_event fixture).
    # Configured languages happening to include the source's own language
    # must not create a duplicate transcript for it.
    mock_graph.get_related_nodes.return_value = [
        {
            "IL_UNIQUE_ID": "do_t_en",
            "languageCode": "en",
            "sourceLanguage": True,
            "status": "Live",
            "artifactUrl": "https://blob/en/transcript.json",
        },
    ]

    result = handle_transcript_approved(
        transcript_approved_event, mock_graph, mock_knowlg, ["en", "hi", "ta"]
    )

    assert set(result.targetLanguages) == {"hi", "ta"}
    assert "en" not in result.targetLanguages
    assert mock_knowlg.post.call_count == 2


def test_created_transcript_includes_display_language_name(transcript_approved_event, mock_graph, mock_knowlg):
    mock_graph.get_related_nodes.return_value = [
        {
            "IL_UNIQUE_ID": "do_t_en",
            "languageCode": "en",
            "sourceLanguage": True,
            "status": "Live",
            "artifactUrl": "https://blob/en/transcript.json",
        },
    ]

    handle_transcript_approved(transcript_approved_event, mock_graph, mock_knowlg, ["hi"])

    posted_payload = mock_knowlg.post.call_args.args[1]
    assert posted_payload["request"]["transcript"]["language"] == ["Hindi"]
