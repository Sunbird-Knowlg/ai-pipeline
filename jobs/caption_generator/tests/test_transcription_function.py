import json
from unittest.mock import MagicMock, patch

from caption_generator.functions.transcription_function import (
    ENRICHED_METADATA_TAG,
    TranscriptionFunction,
    run_transcription_pipeline,
)


def _patch_calls(mock_knowlg):
    return [c for c in mock_knowlg.patch.call_args_list]


def test_pipeline_success_marks_review_by_default(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request, mock_logger
):
    with patch("caption_generator.functions.transcription_function.extract_audio"):
        run_transcription_pipeline(
            transcription_request,
            mock_knowlg,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
            logger=mock_logger,
        )

    mock_transcription_provider.transcribe.assert_called_once()
    assert mock_storage.upload_bytes.call_count == 2

    patch_calls = _patch_calls(mock_knowlg)
    first_call = patch_calls[0]
    assert first_call.args[0] == "object_update"
    assert first_call.args[1] == {"objectType": "Transcript", "status": "Processing"}
    assert first_call.kwargs == {"identifier": "do_123", "objectIdentifier": "do_transcript_1"}

    final_call = patch_calls[-1]
    final_props = final_call.args[1]
    assert final_props["status"] == "Review"
    assert final_props["generatedBy"] == "faster-whisper:large-v3-turbo"
    assert final_call.kwargs == {"identifier": "do_123", "objectIdentifier": "do_transcript_1"}


def test_pipeline_marks_live_when_auto_approve(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request, mock_logger
):
    with patch("caption_generator.functions.transcription_function.extract_audio"):
        run_transcription_pipeline(
            transcription_request,
            mock_knowlg,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=True,
            logger=mock_logger,
        )

    final_props = mock_knowlg.patch.call_args_list[-1].args[1]
    assert final_props["status"] == "Live"


def test_pipeline_uses_language_code_in_object_keys(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request, mock_logger
):
    with patch("caption_generator.functions.transcription_function.extract_audio"):
        run_transcription_pipeline(
            transcription_request,
            mock_knowlg,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
            logger=mock_logger,
        )

    upload_keys = [call.args[1] for call in mock_storage.upload_bytes.call_args_list]
    assert "content/do_123/transcripts/en/transcript.json" in upload_keys
    assert "content/do_123/transcripts/en/captions.vtt" in upload_keys


def test_pipeline_returns_detected_language_code(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request, mock_logger
):
    with patch("caption_generator.functions.transcription_function.extract_audio"):
        language_code = run_transcription_pipeline(
            transcription_request,
            mock_knowlg,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
            logger=mock_logger,
        )

    assert language_code == "en"


def test_pipeline_sets_language_display_name(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request, mock_logger
):
    with patch("caption_generator.functions.transcription_function.extract_audio"):
        run_transcription_pipeline(
            transcription_request,
            mock_knowlg,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
            logger=mock_logger,
        )

    final_props = mock_knowlg.patch.call_args_list[-1].args[1]
    assert final_props["language"] == "English"


def test_process_element_emits_enriched_metadata_on_auto_approve(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request
):
    func = TranscriptionFunction.__new__(TranscriptionFunction)
    func.knowlg = mock_knowlg
    func.storage = mock_storage
    func.logger = MagicMock()
    func._provider = mock_transcription_provider
    func._generated_by = "faster-whisper:large-v3-turbo"
    func._auto_approve = True
    func._config = MagicMock(env="dev")

    with patch("caption_generator.functions.transcription_function.extract_audio"):
        results = list(func.process_element(transcription_request.to_json(), MagicMock()))

    assert len(results) == 1
    tag, payload = results[0]
    assert tag is ENRICHED_METADATA_TAG
    event = json.loads(payload)
    assert event["edata"]["action"] == "approved"
    assert event["edata"]["contentType"] == "Transcript"
    assert event["edata"]["sourceLanguage"] is True
    assert event["edata"]["languageCode"] == "en"
    assert event["object"]["id"] == "do_transcript_1"
    assert event["context"]["env"] == "dev"


def test_process_element_emits_nothing_when_not_auto_approved(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request
):
    func = TranscriptionFunction.__new__(TranscriptionFunction)
    func.knowlg = mock_knowlg
    func.storage = mock_storage
    func.logger = MagicMock()
    func._provider = mock_transcription_provider
    func._generated_by = "faster-whisper:large-v3-turbo"
    func._auto_approve = False

    with patch("caption_generator.functions.transcription_function.extract_audio"):
        results = list(func.process_element(transcription_request.to_json(), MagicMock()))

    assert results == []


def test_process_element_marks_failed_and_emits_dlq_on_error(
    mock_knowlg, mock_storage, mock_transcription_provider, transcription_request
):
    func = TranscriptionFunction.__new__(TranscriptionFunction)
    func.knowlg = mock_knowlg
    func.storage = mock_storage
    func.logger = MagicMock()
    func._provider = mock_transcription_provider
    func._generated_by = "faster-whisper:large-v3-turbo"
    func._auto_approve = False
    func._config = MagicMock()
    func._config.job_name = "caption-generator"

    mock_storage.download_from_uri.side_effect = RuntimeError("download failed")

    results = list(func.process_element(transcription_request.to_json(), MagicMock()))

    assert len(results) == 1
    failed_call = mock_knowlg.patch.call_args_list[-1]
    assert failed_call.args[0] == "object_update"
    assert failed_call.args[1]["status"] == "Failed"
    assert failed_call.args[1]["errorMessage"] == "download failed"
    assert failed_call.kwargs == {"identifier": "do_123", "objectIdentifier": "do_transcript_1"}
