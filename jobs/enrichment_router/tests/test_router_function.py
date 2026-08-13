import json
from unittest.mock import MagicMock, Mock

from enrichment_router.functions.router_function import ROUTER_DLQ_TAG, RouterFunction


def _func(knowlg=None, config=None):
    func = RouterFunction.__new__(RouterFunction)
    func.knowlg = knowlg or Mock()
    func.logger = Mock()
    func._config = config or Mock(env="dev")
    return func


def test_malformed_value_routes_to_dlq_instead_of_raising():
    func = _func()

    results = list(func.process_element("not json", ctx=MagicMock()))

    assert len(results) == 1
    tag, payload = results[0]
    assert tag is ROUTER_DLQ_TAG
    assert "not json" in payload


def test_content_event_ignored_when_action_is_not_publish(mock_knowlg):
    func = _func(knowlg=mock_knowlg)
    event = {
        "id": "do_123",
        "contentType": "Content",
        "action": "retire",
        "data": {"mimeType": "video/mp4"},
    }

    results = list(func.process_element(json.dumps(event), ctx=MagicMock()))

    assert results == []
    mock_knowlg.get.assert_not_called()


def test_content_event_evaluated_when_action_is_publish(mock_knowlg, content_published_event):
    func = _func(knowlg=mock_knowlg, config=Mock(env="dev", raw=lambda key, default=None: ["video/mp4"]))
    mock_knowlg.get.return_value = {"result": {"enrichment": None}}

    results = list(func.process_element(content_published_event.to_json(), ctx=MagicMock()))

    # Eligibility check ran (knowlg.get was called) even though it resulted
    # in a skip (no Enrichment node) - the publish-action event was NOT
    # ignored outright the way a non-publish action is.
    mock_knowlg.get.assert_called_once()
    assert results == []
