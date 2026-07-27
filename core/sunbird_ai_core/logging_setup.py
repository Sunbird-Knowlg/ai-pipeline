import json
import logging
import sys
from datetime import datetime, timezone

# Attributes every stdlib LogRecord carries — used to detect caller-supplied
# `extra={...}` fields (anything on the record beyond this set) without
# hardcoding a field allowlist.
_RESERVED_RECORD_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys())


class JsonFormatter(logging.Formatter):
    """One JSON object per line: timestamp, level, logger name, message,
    plus any caller-supplied `extra={...}` fields merged in directly (e.g.
    logger.info("...", extra={"content_id": content_id})).
    """

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        extra = {k: v for k, v in record.__dict__.items() if k not in _RESERVED_RECORD_ATTRS}
        payload.update(extra)

        return json.dumps(payload, default=str)


def configure_logging(name: str, level: str = "INFO") -> logging.Logger:
    """Returns a logger with a JSON-formatted stdout handler attached.

    Idempotent — safe to call more than once for the same name (e.g. once
    per TaskManager subtask) without stacking duplicate handlers, which
    would otherwise print every line multiple times.
    """
    logger = logging.getLogger(name)
    logger.setLevel(level.upper())
    logger.propagate = False  # avoid double-printing via the root logger's own handlers

    if not any(isinstance(h, logging.StreamHandler) and getattr(h, "_sunbird_json", False) for h in logger.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        handler._sunbird_json = True
        logger.addHandler(handler)

    return logger
