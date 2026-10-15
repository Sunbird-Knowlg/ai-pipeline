import asyncio
import json
import logging
import os
import pathlib
import tempfile
import time
from datetime import timedelta
from typing import Optional

import httpx
import restate
from faster_whisper import WhisperModel
from pydantic import BaseModel
from restate import Context
from restate.exceptions import TerminalError

from register import register_on_boot

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
logger.info(
    "whisper model loaded: size=%s device=%s compute_type=%s", MODEL_SIZE, DEVICE, COMPUTE_TYPE
)

_METADATA = json.loads((pathlib.Path(__file__).parent / "metadata.json").read_text())
_ABORT_TIMEOUT_MINUTES = _METADATA["config"]["abortTimeoutMinutes"]


class TranscribeRequest(BaseModel):
    artifactUrl: str
    language: Optional[str] = None


class WhisperSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str


class TranscribeResponse(BaseModel):
    language: str
    languageProbability: float
    duration: float
    segments: list[WhisperSegment]


def _download(artifact_url: str) -> str:
    logger.debug("downloading artifact: %s", artifact_url)
    started = time.monotonic()
    with httpx.Client(timeout=None) as client:
        response = client.get(artifact_url)
        if response.status_code != 200:
            logger.error("failed to fetch artifact %s: %s", artifact_url, response.status_code)
            raise TerminalError(f"failed to fetch {artifact_url}: {response.status_code}")
        suffix = os.path.splitext(artifact_url.split("?")[0])[1] or ".media"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(response.content)
            logger.debug(
                "downloaded artifact to %s (%d bytes, %.2fs)",
                tmp.name,
                len(response.content),
                time.monotonic() - started,
            )
            return tmp.name


def _transcribe(tmp_path: str, language: Optional[str]) -> TranscribeResponse:
    logger.debug(
        "starting transcription: %s (language hint: %s)", tmp_path, language or "auto-detect"
    )
    started = time.monotonic()
    try:
        segments_iter, info = model.transcribe(tmp_path, language=language, vad_filter=True)
        segments = []
        for i, seg in enumerate(segments_iter):
            segments.append(WhisperSegment(id=i, start=seg.start, end=seg.end, text=seg.text))
            if i % 10 == 0:
                logger.debug("transcribing: segment %d at %.1fs", i, seg.start)
    finally:
        os.remove(tmp_path)
    logger.info(
        "transcription complete: language=%s duration=%.1fs segments=%d elapsed=%.1fs",
        info.language,
        info.duration,
        len(segments),
        time.monotonic() - started,
    )
    return TranscribeResponse(
        language=info.language,
        languageProbability=info.language_probability,
        duration=info.duration,
        segments=segments,
    )


def _download_and_transcribe(artifact_url: str, language: Optional[str]) -> TranscribeResponse:
    """Download and transcribe as one journaled step, not two. If this step is retried (e.g. Restate
    aborted and re-invoked the handler after `abort_timeout`, while the original, now-orphaned
    attempt was still running), a retry gets its own fresh tempfile from its own fresh download
    rather than reusing a path journaled by an earlier `download` step -- which the earlier
    attempt's `finally: os.remove(tmp_path)` could have already deleted out from under it. That
    race was the actual cause of the "No such file or directory" loop seen in production."""
    tmp_path = _download(artifact_url)
    return _transcribe(tmp_path, language)


whisper_service = restate.Service(
    "WhisperService",
    abort_timeout=timedelta(minutes=_ABORT_TIMEOUT_MINUTES),
)


@whisper_service.handler()
async def transcribe(ctx: Context, req: TranscribeRequest) -> TranscribeResponse:
    logger.info("transcribe request received: artifactUrl=%s", req.artifactUrl)
    return await ctx.run_typed(
        "transcribe", _download_and_transcribe, artifact_url=req.artifactUrl, language=req.language
    )


app = restate.app([whisper_service])

# Self-registers with core-api once hypercorn is actually serving — see register.py.
#
# register_on_boot() must NOT be awaited inline here. Hypercorn will not accept any connection on
# its port -- including core-api's own callback to verify this process is real -- until it
# receives lifespan.startup.complete. Awaiting registration before sending that message deadlocks
# every time: registration can't succeed until the port is open, and the port can't open until
# registration (as awaited here) returns. Confirmed on the real cluster: hypercorn's own
# wait_for_startup() timed out first every time, hypercorn exited, Kubernetes restarted the
# container, and the cycle repeated forever. So: send .complete immediately, and run registration
# as a background task that starts the instant the port is actually open.
_original_app = app


async def _register_or_die() -> None:
    """If registration ultimately fails for a real reason, exit hard so Kubernetes restarts the
    container -- same guarantee the previous inline/awaited version had. A plain exception here
    would otherwise just be logged by asyncio as "never retrieved" and this process would keep
    running, unregistered, forever."""
    try:
        await register_on_boot()
    except Exception:
        logger.exception("registration failed, exiting so the container restarts")
        os._exit(1)


async def app(scope, receive, send):  # noqa: F811 - wraps the restate ASGI app with a lifespan hook
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                asyncio.create_task(_register_or_die())
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    else:
        await _original_app(scope, receive, send)
