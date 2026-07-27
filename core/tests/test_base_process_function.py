import json
from unittest.mock import MagicMock, patch

import pytest
from sunbird_ai_core.base.base_process_function import BaseProcessFunction

_RAW_CONFIG = {
    "janusgraph_auth": {},
}


class _ConcreteProcessFunction(BaseProcessFunction):
    """PyFlink's ProcessFunction.process_element is abstract — a minimal
    concrete subclass is needed to instantiate BaseProcessFunction at all.
    """

    def process_element(self, value, ctx):
        yield value


def _fake_config():
    config = MagicMock()
    config.job_name = "test-job"
    config.log_level = "INFO"
    config.janusgraph_host = "localhost"
    config.janusgraph_port = 8182
    config.schema_base_path = "https://blob.example.com/schemas"
    config.cloud_storage_type = "azure"
    config.cloud_storage_auth_type = "DEV"
    config.cloud_storage_container = "test-container"
    config.knowlg_content_service_url = "https://knowlg.example.com"
    config.knowlg_api_key = ""
    config.knowlg_apis = {}
    config.raw.side_effect = lambda key, default=None: _RAW_CONFIG.get(key, default)
    return config


def _runtime_context(subtask_index=0):
    ctx = MagicMock()
    ctx.get_index_of_this_subtask.return_value = subtask_index
    return ctx


@patch("sunbird_ai_core.base.base_process_function.KnowlgClient")
@patch("sunbird_ai_core.base.base_process_function.BlobStorageUtil")
@patch("sunbird_ai_core.base.base_process_function.JanusGraphUtil")
def test_open_wires_all_services(mock_graph_cls, mock_storage_cls, mock_knowlg_cls):
    func = _ConcreteProcessFunction(_fake_config())

    func.open(_runtime_context(subtask_index=2))

    mock_graph_cls.return_value.open.assert_called_once()
    assert func.graph is mock_graph_cls.return_value
    assert func.storage is mock_storage_cls.return_value
    assert func.knowlg is mock_knowlg_cls.return_value
    assert func.logger is not None


@patch("sunbird_ai_core.base.base_process_function.KnowlgClient", side_effect=RuntimeError("boom"))
@patch("sunbird_ai_core.base.base_process_function.BlobStorageUtil")
@patch("sunbird_ai_core.base.base_process_function.JanusGraphUtil")
def test_open_closes_graph_when_later_init_fails(mock_graph_cls, mock_storage_cls, mock_knowlg_cls):
    func = _ConcreteProcessFunction(_fake_config())

    with pytest.raises(RuntimeError):
        func.open(_runtime_context())

    mock_graph_cls.return_value.open.assert_called_once()
    mock_graph_cls.return_value.close.assert_called_once()


@patch("sunbird_ai_core.base.base_process_function.KnowlgClient")
@patch("sunbird_ai_core.base.base_process_function.BlobStorageUtil")
@patch("sunbird_ai_core.base.base_process_function.JanusGraphUtil")
def test_close_closes_graph_when_open(mock_graph_cls, mock_storage_cls, mock_knowlg_cls):
    func = _ConcreteProcessFunction(_fake_config())
    func.open(_runtime_context())

    func.close()

    mock_graph_cls.return_value.close.assert_called_once()


def test_close_is_a_no_op_before_open():
    func = _ConcreteProcessFunction(_fake_config())
    func.close()  # must not raise even though open() was never called


def test_emit_to_dlq_raises_before_open():
    func = _ConcreteProcessFunction(_fake_config())
    ctx = MagicMock()

    with pytest.raises(RuntimeError):
        next(func.emit_to_dlq({"id": "do_123"}, ValueError("bad event"), ctx, MagicMock()))


@patch("sunbird_ai_core.base.base_process_function.KnowlgClient")
@patch("sunbird_ai_core.base.base_process_function.BlobStorageUtil")
@patch("sunbird_ai_core.base.base_process_function.JanusGraphUtil")
def test_emit_to_dlq_yields_envelope_after_open(mock_graph_cls, mock_storage_cls, mock_knowlg_cls):
    func = _ConcreteProcessFunction(_fake_config())
    func.open(_runtime_context())
    output_tag = MagicMock()

    tag, payload = next(func.emit_to_dlq({"id": "do_123"}, ValueError("bad event"), MagicMock(), output_tag))

    assert tag is output_tag
    envelope = json.loads(payload)
    assert envelope["errorMessage"] == "bad event"
    assert envelope["jobName"] == "test-job"
    assert envelope["originalEvent"] == {"id": "do_123"}
