import json
from unittest.mock import MagicMock, patch

import pytest
from caption_generator.functions.transcription_function import (
    ENRICHED_METADATA_TAG,
    TranscriptionFunction,
    run_transcription_pipeline,
)


def test_pipeline_success_marks_review_by_default(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": "en"}

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ) as mock_sync:
        run_transcription_pipeline(
            transcription_request,
            mock_graph,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
        )

    mock_transcription_provider.transcribe.assert_called_once()
    assert mock_storage.upload_bytes.call_count == 2

    status_calls = [c for c in mock_graph.update_node.call_args_list]
    assert status_calls[0].args == ("do_transcript_1", {"status": "Processing"})

    final_props = status_calls[-1].args[1]
    assert final_props["status"] == "Review"
    assert final_props["autoApproved"] is False
    assert final_props["generatedBy"] == "faster-whisper:large-v3-turbo"

    mock_sync.assert_called_once_with(mock_graph, "do_enrich_1")


def test_pipeline_marks_live_when_auto_approve(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": "en"}

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ):
        run_transcription_pipeline(
            transcription_request,
            mock_graph,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=True,
        )

    final_props = mock_graph.update_node.call_args_list[-1].args[1]
    assert final_props["status"] == "Live"
    assert final_props["autoApproved"] is True


def test_pipeline_uses_language_code_in_object_keys(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": "en"}

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ):
        run_transcription_pipeline(
            transcription_request,
            mock_graph,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
        )

    upload_keys = [call.args[1] for call in mock_storage.upload_bytes.call_args_list]
    assert "content/do_123/transcripts/en/transcript.json" in upload_keys
    assert "content/do_123/transcripts/en/captions.vtt" in upload_keys


def test_pipeline_returns_detected_language_code(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": ""}

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ):
        language_code = run_transcription_pipeline(
            transcription_request,
            mock_graph,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
        )

    assert language_code == "en"


def test_pipeline_sets_language_display_name(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": ""}

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ):
        run_transcription_pipeline(
            transcription_request,
            mock_graph,
            mock_storage,
            mock_transcription_provider,
            generated_by="faster-whisper:large-v3-turbo",
            auto_approve=False,
        )

    final_props = mock_graph.update_node.call_args_list[-1].args[1]
    assert final_props["language"] == ["English"]


def test_process_element_emits_enriched_metadata_on_auto_approve(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": ""}

    func = TranscriptionFunction.__new__(TranscriptionFunction)
    func.graph = mock_graph
    func.storage = mock_storage
    func.logger = MagicMock()
    func._provider = mock_transcription_provider
    func._generated_by = "faster-whisper:large-v3-turbo"
    func._auto_approve = True

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ):
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


def test_process_element_emits_nothing_when_not_auto_approved(
    mock_graph, mock_storage, mock_transcription_provider, transcription_request
):
    mock_graph.get_node.return_value = {"languageCode": ""}

    func = TranscriptionFunction.__new__(TranscriptionFunction)
    func.graph = mock_graph
    func.storage = mock_storage
    func.logger = MagicMock()
    func._provider = mock_transcription_provider
    func._generated_by = "faster-whisper:large-v3-turbo"
    func._auto_approve = False

    with patch("caption_generator.functions.transcription_function.extract_audio"), patch(
        "caption_generator.functions.transcription_function.sync_enrichment_transcripts"
    ):
        results = list(func.process_element(transcription_request.to_json(), MagicMock()))

    assert results == []
