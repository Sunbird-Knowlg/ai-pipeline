import json
from unittest.mock import Mock, patch

import pytest
from caption_generator.providers.multilingual.litellm_provider import LiteLLMProvider
from caption_generator.segment import Segment


def _provider():
    return LiteLLMProvider(model="azure/gpt-5-mini", api_key="secret")


def _mock_response(content: dict) -> Mock:
    response = Mock()
    response.choices = [Mock(message=Mock(content=json.dumps(content)))]
    return response


@patch("caption_generator.providers.multilingual.litellm_provider.litellm.completion")
def test_translate_exact_match(mock_completion):
    mock_completion.return_value = _mock_response({"0": "Bonjour", "1": "Monde"})
    segments = [Segment(id=0, start=0.0, end=1.0, text="Hello"), Segment(id=1, start=1.0, end=2.0, text="World")]

    result, had_fallback = _provider().translate(segments, "en", "fr")

    assert [s.text for s in result] == ["Bonjour", "Monde"]
    assert [s.id for s in result] == [0, 1]
    assert had_fallback is False


@patch("caption_generator.providers.multilingual.litellm_provider.litellm.completion")
def test_translate_falls_back_to_original_text_for_missing_ids(mock_completion):
    mock_completion.return_value = _mock_response({"0": "Bonjour"})
    segments = [Segment(id=0, start=0.0, end=1.0, text="Hello"), Segment(id=1, start=1.0, end=2.0, text="World")]

    result, had_fallback = _provider().translate(segments, "en", "fr")

    assert result[0].text == "Bonjour"
    assert result[1].text == "World"  # untranslated fallback, not dropped/raised
    assert had_fallback is True


@patch("caption_generator.providers.multilingual.litellm_provider.litellm.completion")
def test_translate_ignores_extra_ids(mock_completion):
    mock_completion.return_value = _mock_response({"0": "Bonjour", "99": "phantom"})
    segments = [Segment(id=0, start=0.0, end=1.0, text="Hello")]

    result, had_fallback = _provider().translate(segments, "en", "fr")

    assert len(result) == 1
    assert result[0].text == "Bonjour"
    assert had_fallback is False


@patch("caption_generator.providers.multilingual.litellm_provider.litellm.completion")
def test_translate_raises_when_response_has_no_overlap(mock_completion):
    mock_completion.return_value = _mock_response({})
    segments = [Segment(id=0, start=0.0, end=1.0, text="Hello")]

    with pytest.raises(ValueError):
        _provider().translate(segments, "en", "fr")


@patch("caption_generator.providers.multilingual.litellm_provider.litellm.completion")
def test_translate_raises_when_ids_dont_overlap_at_all(mock_completion):
    mock_completion.return_value = _mock_response({"99": "phantom"})
    segments = [Segment(id=0, start=0.0, end=1.0, text="Hello")]

    with pytest.raises(ValueError):
        _provider().translate(segments, "en", "fr")


@patch("caption_generator.providers.multilingual.litellm_provider.litellm.completion")
def test_translate_passes_reasoning_effort_and_json_mode(mock_completion):
    mock_completion.return_value = _mock_response({"0": "Bonjour"})
    segments = [Segment(id=0, start=0.0, end=1.0, text="Hello")]

    _provider().translate(segments, "en", "fr")

    kwargs = mock_completion.call_args.kwargs
    assert kwargs["reasoning_effort"] == "minimal"
    assert kwargs["response_format"] == {"type": "json_object"}
    assert kwargs["max_completion_tokens"] == 4000
