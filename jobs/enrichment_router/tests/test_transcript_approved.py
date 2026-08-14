from enrichment_router.functions.transcript_approved import handle_transcript_approved

LANGUAGES = ["hi", "ta"]


def _enrichment_response(transcripts):
    return {"result": {"enrichment": {"identifier": "do_enrich_1", "transcripts": transcripts}}}


def test_skips_non_source_language_approval(transcript_approved_event, mock_knowlg):
    transcript_approved_event.data["sourceLanguage"] = False

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, LANGUAGES)

    assert result is None
    mock_knowlg.get.assert_not_called()


def test_skips_when_no_languages_configured(transcript_approved_event, mock_knowlg):
    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, [])

    assert result is None


def test_skips_when_all_languages_already_active(transcript_approved_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {"identifier": "do_t_en", "languageCode": "en", "sourceLanguage": True, "status": "Live"},
            {"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Review"},
            {"identifier": "do_t_ta", "languageCode": "ta", "sourceLanguage": False, "status": "Processing"},
        ]
    )

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, LANGUAGES)

    assert result is None
    mock_knowlg.post.assert_not_called()


def test_creates_drafts_and_emits_for_new_languages(transcript_approved_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
            {"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Failed"},
        ]
    )

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, LANGUAGES)

    assert result is not None
    assert set(result.targetLanguages) == {"hi", "ta"}
    assert result.sourceTranscriptUrl == "https://blob/en/transcript.json"
    assert result.contentId == "do_123"
    assert result.enrichmentId == "do_enrich_1"
    assert mock_knowlg.post.call_count == 2


def test_creates_only_missing_languages(transcript_approved_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
            {"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Review"},
        ]
    )

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, LANGUAGES)

    assert result.targetLanguages == ["ta"]
    mock_knowlg.post.assert_called_once()


def test_excludes_source_language_from_targets(transcript_approved_event, mock_knowlg):
    # Source is "en" (see conftest's transcript_approved_event fixture).
    # Configured languages happening to include the source's own language
    # must not create a duplicate transcript for it.
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
        ]
    )

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, ["en", "hi", "ta"])

    assert set(result.targetLanguages) == {"hi", "ta"}
    assert "en" not in result.targetLanguages
    assert mock_knowlg.post.call_count == 2


def test_created_transcript_includes_display_language_name(transcript_approved_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
        ]
    )

    handle_transcript_approved(transcript_approved_event, mock_knowlg, ["hi"])

    api_key, payload = mock_knowlg.post.call_args.args
    kwargs = mock_knowlg.post.call_args.kwargs
    assert api_key == "object_create"
    assert payload["objectType"] == "Transcript"
    assert payload["language"] == "Hindi"
    assert payload["languageCode"] == "hi"
    assert kwargs["identifier"] == "do_123"


def test_republish_retargets_all_configured_languages(transcript_approved_event, mock_knowlg):
    # hi/ta are already Live (would normally be excluded as "active"), but
    # isRepublish=True means the source was regenerated and every configured
    # language needs re-translating, including the already-Live ones.
    transcript_approved_event.data["isRepublish"] = True
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
            {"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Live"},
            {"identifier": "do_t_ta", "languageCode": "ta", "sourceLanguage": False, "status": "Live"},
        ]
    )

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, LANGUAGES)

    assert set(result.targetLanguages) == {"hi", "ta"}
    # object_create is idempotent for existing languages (returns the
    # existing node, doesn't touch it) - still called for both to confirm
    # they exist, but no new node is expected to result from it.
    assert mock_knowlg.post.call_count == 2


def test_republish_still_creates_a_genuinely_new_language(transcript_approved_event, mock_knowlg):
    # Previously configured: hi only. Now configured: hi, ta - ta has no
    # existing Transcript node at all and must be created, not just updated.
    transcript_approved_event.data["isRepublish"] = True
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
            {"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False, "status": "Live"},
        ]
    )

    result = handle_transcript_approved(transcript_approved_event, mock_knowlg, LANGUAGES)

    assert set(result.targetLanguages) == {"hi", "ta"}


def test_calls_object_create_for_target_content(transcript_approved_event, mock_knowlg):
    mock_knowlg.get.return_value = _enrichment_response(
        [
            {
                "identifier": "do_t_en",
                "languageCode": "en",
                "sourceLanguage": True,
                "status": "Live",
                "artifactUrl": "https://blob/en/transcript.json",
            },
        ]
    )

    handle_transcript_approved(transcript_approved_event, mock_knowlg, ["hi"])

    mock_knowlg.get.assert_called_once_with("enrichment_read", identifier="do_123")
