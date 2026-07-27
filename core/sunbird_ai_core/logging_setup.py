import json
import logging
import os
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


class _RawFdHandler(logging.Handler):
    """Writes straight to the fd 1 syscall, bypassing sys.stdout.write().

    PyFlink's Beam SDK worker (beam_sdk_worker_main.py) monkeypatches
    sys.stdout.write to call logging.getLogger().info(msg) so that stray
    print()s show up in Flink's logs. A StreamHandler(sys.stdout) attached
    to the root logger therefore feeds every formatted record straight back
    into the root logger as a new record — infinite synchronous recursion,
    each layer re-escaping the previous line as its "message" field, until
    the process runs out of stack/memory. Writing via os.write on the raw
    fd never touches the patched .write(), so it can't loop back.
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            os.write(1, (self.format(record) + "\n").encode("utf-8", errors="replace"))
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
