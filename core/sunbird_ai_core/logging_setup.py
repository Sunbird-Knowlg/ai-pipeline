import json
import logging
import os
from datetime import datetime, timezone

# Every stdlib LogRecord attribute — anything beyond this set is a caller-supplied extra={...} field.
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
        # Fixed fields always win — a caller passing extra={"message": ...} or
        # similar can't overwrite the record's own timestamp/level/logger/message.
        extra.update(payload)
        payload = extra

        return json.dumps(payload, default=str)


class _RawFdHandler(logging.Handler):
    """Writes straight to the fd 1 syscall — never via sys.stdout.write(),
    which PyFlink's Beam SDK worker monkeypatches back into the root logger
    (StreamHandler(sys.stdout) here would recurse into itself infinitely).
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            data = (self.format(record) + "\n").encode("utf-8", errors="replace")
            # os.write() on a pipe/socket fd can write fewer bytes than
            # requested for a large line — loop until it's all out.
            view = memoryview(data)
            while view:
                view = view[os.write(1, view):]
        except Exception:
            self.handleError(record)


def configure_logging(name: str, level: str = "INFO") -> logging.Logger:
    """Attaches a JSON-formatted stdout handler to the ROOT logger (once,
    idempotently) and returns a named logger for the caller's own use.

    Handler goes on the root, not on the `name` logger, so that every
    module's own `logging.getLogger(__name__)` call anywhere in the process
    — a completely separate logger from `name` in the hierarchy — still
    inherits it via normal propagation. Call this once per process (e.g.
    once per TaskManager subtask in BaseProcessFunction.open()); every
    other file just does `logging.getLogger(__name__)` and logs normally,
    no per-class wiring needed.
    """
    root = logging.getLogger()
    root.setLevel(level.upper())

    if not any(getattr(h, "_sunbird_json", False) for h in root.handlers):
        handler = _RawFdHandler()
        handler.setFormatter(JsonFormatter())
        handler._sunbird_json = True
        root.addHandler(handler)

    return logging.getLogger(name)
