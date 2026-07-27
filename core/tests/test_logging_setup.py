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


def test_configure_logging_does_not_duplicate_handlers():
    logger = configure_logging("test-idempotent-job")
    handler_count_after_first = len(logger.handlers)

    logger_again = configure_logging("test-idempotent-job")

    assert logger is logger_again
    assert len(logger_again.handlers) == handler_count_after_first


def test_configure_logging_emits_valid_json_line():
    logger = configure_logging("test-emit-job")
    stream = io.StringIO()
    logger.handlers[0].stream = stream

    logger.info("test message", extra={"transcript_id": "do_456"})

    line = stream.getvalue().strip()
    payload = json.loads(line)
    assert payload["message"] == "test message"
    assert payload["transcript_id"] == "do_456"
