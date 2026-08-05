from unittest.mock import Mock

import pytest
from caption_generator.functions.multilingual_function import (
    MultilingualFunction,
    resolve_target_transcript_ids,
    translate_one_language,
)


def test_resolve_target_transcript_ids_excludes_source_language(mock_knowlg):
    mock_knowlg.get.return_value = {
        "result": {
            "enrichment": {
                "identifier": "do_enrich_1",
                "transcripts": [
                    {"identifier": "do_t_en", "languageCode": "en", "sourceLanguage": True},
                    {"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False},
                    {"identifier": "do_t_ta", "languageCode": "ta", "sourceLanguage": False},
                ],
            }
        }
    }

    result = resolve_target_transcript_ids(mock_knowlg, "do_123", ["hi", "ta", "fr"])

    assert result == {"hi": "do_t_hi", "ta": "do_t_ta"}
    mock_knowlg.get.assert_called_once_with("enrichment_read", identifier="do_123")


def test_translate_one_language_success(mock_knowlg, mock_storage, sample_segments):
    provider = Mock()
    provider.translate.side_effect = lambda segments, src, tgt: segments

    translate_one_language(
        content_id="do_123",
        transcript_id="do_t_hi",
        source_segments=sample_segments,
        source_lang="en",
        target_lang="hi",
        knowlg=mock_knowlg,
        storage=mock_storage,
        provider=provider,
        batch_size=80,
        overlap=2,
        auto_approve=False,
    )

    assert mock_storage.upload_bytes.call_count == 2
    final_call = mock_knowlg.patch.call_args
    assert final_call.args[0] == "object_update"
    final_props = final_call.args[1]
    assert final_props["status"] == "Review"
    assert final_props["generatedBy"] == "litellm"
    assert final_call.kwargs == {"identifier": "do_123", "objectIdentifier": "do_t_hi"}


def test_translate_one_language_marks_failed_on_error(mock_knowlg, mock_storage, sample_segments):
    provider = Mock()
    provider.translate.side_effect = RuntimeError("LLM timeout")

    with pytest.raises(RuntimeError):
        translate_one_language(
            content_id="do_123",
            transcript_id="do_t_hi",
            source_segments=sample_segments,
            source_lang="en",
            target_lang="hi",
            knowlg=mock_knowlg,
            storage=mock_storage,
            provider=provider,
            batch_size=80,
            overlap=2,
            auto_approve=False,
        )

    mock_knowlg.patch.assert_called_once_with(
        "object_update",
        {"objectType": "Transcript", "status": "Failed", "errorMessage": "LLM timeout"},
        identifier="do_123",
        objectIdentifier="do_t_hi",
    )
    mock_storage.upload_bytes.assert_not_called()


def test_process_element_dlqs_instead_of_crashing_on_m2_failure(
    mock_knowlg, mock_storage, multilingual_request
):
    """A bad sourceTranscriptUrl (or any M1/M2 failure) must route to DLQ,
    not raise — an uncaught exception here fails the whole Flink job, and
    since the triggering Kafka offset never commits, the same message
    replays and crash-loops the job forever on restart.
    """
    mock_knowlg.get.return_value = {
        "result": {"enrichment": {"transcripts": [{"identifier": "do_t_hi", "languageCode": "hi", "sourceLanguage": False}]}}
    }
    mock_storage.download_from_uri.side_effect = ValueError("Refusing to download from disallowed scheme: ''")

    func = MultilingualFunction(config=Mock())
    func.knowlg = mock_knowlg
    func.storage = mock_storage
    func.logger = Mock()
    func._auto_approve = True

    request = multilingual_request
    request.targetLanguages = ["hi"]
    results = list(func.process_element(request.to_json(), ctx=Mock()))

    assert len(results) == 1
    tag, payload = results[0]
    assert tag.tag_id == "multilingual-dlq"
    assert "Refusing to download" in payload

    failed_calls = [c for c in mock_knowlg.patch.call_args_list if c.args[1].get("status") == "Failed"]
    assert len(failed_calls) == 1
    assert failed_calls[0].kwargs == {"identifier": "do_123", "objectIdentifier": "do_t_hi"}
