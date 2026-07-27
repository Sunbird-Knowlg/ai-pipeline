from unittest.mock import Mock, patch

import pytest
import requests
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient

APIS = {
    "transcript_create": "/content/v4/transcript/create",
    "content_read": "/content/v4/read/{identifier}",
}


def _client():
    return KnowlgClient(content_service_url="https://knowlg.example.com/", api_key="secret", apis=APIS)


@patch("sunbird_ai_core.knowlg.knowlg_client.requests.post")
def test_post_resolves_configured_path(mock_post):
    mock_response = Mock()
    mock_response.json.return_value = {"result": {"identifier": "do_123"}}
    mock_response.raise_for_status = Mock()
    mock_post.return_value = mock_response

    result = _client().post("transcript_create", {"name": "x"})

    mock_post.assert_called_once()
    called_url = mock_post.call_args[0][0]
    assert called_url == "https://knowlg.example.com/content/v4/transcript/create"
    assert result == {"result": {"identifier": "do_123"}}


@patch("sunbird_ai_core.knowlg.knowlg_client.requests.get")
def test_get_substitutes_identifier(mock_get):
    mock_response = Mock()
    mock_response.json.return_value = {"result": {}}
    mock_response.raise_for_status = Mock()
    mock_get.return_value = mock_response

    _client().get("content_read", "do_123")

    called_url = mock_get.call_args[0][0]
    assert called_url == "https://knowlg.example.com/content/v4/read/do_123"


def test_unknown_api_key_raises():
    with pytest.raises(KeyError):
        _client().post("does_not_exist", {})


def test_no_auth_header_when_api_key_not_set():
    client = KnowlgClient(content_service_url="https://knowlg.example.com/", apis=APIS)
    assert "Authorization" not in client._headers()


def test_auth_header_present_when_api_key_set():
    assert _client()._headers()["Authorization"] == "Bearer secret"


def test_get_url_encodes_path_traversal_attempt():
    assert _client()._resolve_path("content_read", identifier="../../etc/passwd") == (
        "/content/v4/read/..%2F..%2Fetc%2Fpasswd"
    )


@patch("sunbird_ai_core.knowlg.knowlg_client.requests.get")
def test_get_raises_on_connection_error(mock_get):
    mock_get.side_effect = requests.exceptions.ConnectionError("refused")

    with pytest.raises(requests.exceptions.ConnectionError):
        _client().get("content_read", "do_123")


@patch("sunbird_ai_core.knowlg.knowlg_client.requests.post")
def test_post_raises_value_error_on_non_json_body(mock_post):
    mock_response = Mock()
    mock_response.raise_for_status = Mock()
    mock_response.json.side_effect = ValueError("not json")
    mock_post.return_value = mock_response

    with pytest.raises(ValueError):
        _client().post("transcript_create", {"name": "x"})
