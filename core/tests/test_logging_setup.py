import io
import json
import logging

from sunbird_ai_core.logging_setup import JsonFormatter, configure_logging


def test_json_formatter_includes_standard_fields():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="test-job", level=logging.INFO, pathname="", lineno=0,
        msg="hello %s", args=("world",), exc_info=None,
    )
    payload = json.loads(formatter.format(record))

    assert payload["level"] == "INFO"
    assert payload["logger"] == "test-job"
    assert payload["message"] == "hello world"
    assert "timestamp" in payload


def test_json_formatter_merges_extra_fields():
    formatter = JsonFormatter()
    record = logging.LogRecord(
        name="test-job", level=logging.INFO, pathname="", lineno=0,
        msg="processing", args=(), exc_info=None,
    )
    record.content_id = "do_123"
    payload = json.loads(formatter.format(record))

    assert payload["content_id"] == "do_123"


def test_configure_logging_does_not_duplicate_root_handler():
    configure_logging("test-idempotent-job")
    root = logging.getLogger()
    handler_count_after_first = sum(1 for h in root.handlers if getattr(h, "_sunbird_json", False))

    configure_logging("test-idempotent-job")

    handler_count_after_second = sum(1 for h in root.handlers if getattr(h, "_sunbird_json", False))
    assert handler_count_after_second == handler_count_after_first == 1


def test_configure_logging_makes_arbitrary_module_logger_emit_json():
    configure_logging("test-emit-job")
    root = logging.getLogger()
    json_handler = next(h for h in root.handlers if getattr(h, "_sunbird_json", False))

    stream = io.StringIO()
    json_handler.stream = stream

    # Any unrelated module logger — not the "test-emit-job" logger itself —
    # must still emit JSON via root propagation, with zero per-module setup.
    other_module_logger = logging.getLogger("some.totally.unrelated.module")
    other_module_logger.info("test message", extra={"transcript_id": "do_456"})

    line = stream.getvalue().strip()
    payload = json.loads(line)
    assert payload["message"] == "test message"
    assert payload["transcript_id"] == "do_456"
    assert payload["logger"] == "some.totally.unrelated.module"
