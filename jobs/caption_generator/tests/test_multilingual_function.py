from unittest.mock import Mock

import pytest
from caption_generator.functions.multilingual_function import (
    resolve_target_transcript_ids,
    translate_one_language,
)


def test_resolve_target_transcript_ids_excludes_source_language(mock_graph):
    mock_graph.get_related_nodes.return_value = [
        {"IL_UNIQUE_ID": "do_t_en", "languageCode": "en", "sourceLanguage": True},
        {"IL_UNIQUE_ID": "do_t_hi", "languageCode": "hi", "sourceLanguage": False},
        {"IL_UNIQUE_ID": "do_t_ta", "languageCode": "ta", "sourceLanguage": False},
    ]

    result = resolve_target_transcript_ids(mock_graph, "do_enrich_1", ["hi", "ta", "fr"])

    assert result == {"hi": "do_t_hi", "ta": "do_t_ta"}


def test_translate_one_language_success(mock_graph, mock_storage, sample_segments):
    provider = Mock()
    provider.translate.side_effect = lambda segments, src, tgt: segments

    translate_one_language(
        content_id="do_123",
        transcript_id="do_t_hi",
        source_segments=sample_segments,
        source_lang="en",
        target_lang="hi",
        graph=mock_graph,
        storage=mock_storage,
        provider=provider,
        batch_size=80,
        overlap=2,
        auto_approve=False,
    )

    assert mock_storage.upload_bytes.call_count == 2
    final_props = mock_graph.update_node.call_args.args[1]
    assert final_props["status"] == "Review"
    assert final_props["generatedBy"] == "litellm"


def test_translate_one_language_marks_failed_on_error(mock_graph, mock_storage, sample_segments):
    provider = Mock()
    provider.translate.side_effect = RuntimeError("LLM timeout")

    with pytest.raises(RuntimeError):
        translate_one_language(
            content_id="do_123",
            transcript_id="do_t_hi",
            source_segments=sample_segments,
            source_lang="en",
            target_lang="hi",
            graph=mock_graph,
            storage=mock_storage,
            provider=provider,
            batch_size=80,
            overlap=2,
            auto_approve=False,
        )

    mock_graph.update_node.assert_called_once_with(
        "do_t_hi", {"status": "Failed", "errorMessage": "LLM timeout"}
    )
    mock_storage.upload_bytes.assert_not_called()
