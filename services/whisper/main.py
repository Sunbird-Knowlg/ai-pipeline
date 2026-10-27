import asyncio
import json
import logging
import os
import pathlib
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Optional

import httpx
import restate
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps
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
# Matches the pod's actual CPU limit; cpu_threads below is sized off this, not os.cpu_count()
# (which reports the host's cores, not the container's cgroup limit).
CPU_CORES = int(os.environ.get("WHISPER_CPU_CORES", "4"))
# Chunks run concurrently (see _transcribe), so both the thread pool and the model itself need to
# know the fan-out: num_workers lets CTranslate2 actually run concurrent transcribe() calls in
# parallel instead of serializing them internally, and cpu_threads is divided across that fan-out
# so concurrent chunks don't oversubscribe the pod's CPU limit.
MAX_CONCURRENT_CHUNKS = int(os.environ.get("WHISPER_MAX_CONCURRENT_CHUNKS", "4"))
CPU_THREADS_PER_CHUNK = max(1, CPU_CORES // MAX_CONCURRENT_CHUNKS)

model = WhisperModel(
    MODEL_SIZE,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    cpu_threads=CPU_THREADS_PER_CHUNK,
    num_workers=MAX_CONCURRENT_CHUNKS,
)
logger.info(
    "whisper model loaded: size=%s device=%s compute_type=%s cpu_threads=%d num_workers=%d",
    MODEL_SIZE,
    DEVICE,
    COMPUTE_TYPE,
    CPU_THREADS_PER_CHUNK,
    MAX_CONCURRENT_CHUNKS,
)
SAMPLE_RATE = model.feature_extractor.sampling_rate

_METADATA = json.loads((pathlib.Path(__file__).parent / "metadata.json").read_text())
_ABORT_TIMEOUT_MINUTES = _METADATA["config"]["abortTimeoutMinutes"]
# Target length for a VAD-aligned chunk, and how much silence must surround a cut for it to count
# as a real boundary rather than the forced "longest available gap" fallback.
_CHUNK_TARGET_SECONDS = _METADATA["config"]["chunkTargetSeconds"]
_CHUNK_MIN_SILENCE_MS = _METADATA["config"]["chunkMinSilenceMs"]


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
    logger.info("download started: %s", artifact_url)
    started = time.monotonic()
    suffix = os.path.splitext(artifact_url.split("?")[0])[1] or ".media"
    # Streamed to disk rather than buffered via response.content: the old version held the whole
    # artifact in RAM before writing it out, doubling peak memory for no reason.
    with httpx.Client(timeout=None) as client, client.stream("GET", artifact_url) as response:
        if response.status_code != 200:
            logger.error("download failed: %s -> HTTP %d", artifact_url, response.status_code)
            raise TerminalError(f"failed to fetch {artifact_url}: {response.status_code}")
        total_bytes = 0
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            for data in response.iter_bytes():
                tmp.write(data)
                total_bytes += len(data)
            tmp_path = tmp.name
    logger.info(
        "download complete: %s (%.1f MB, %.2fs)",
        tmp_path,
        total_bytes / 1_000_000,
        time.monotonic() - started,
    )
    return tmp_path


def _transcribe_chunk(
    index: int, boundary: dict, audio, language: Optional[str]
) -> tuple[list[tuple[float, float, str]], object]:
    """Transcribes one VAD-bounded slice of the already-decoded audio array. Runs on a worker
    thread (see _transcribe's ThreadPoolExecutor) -- CTranslate2 releases the GIL during inference,
    and num_workers on the model (set at startup) lets these calls actually run concurrently
    instead of queuing behind each other."""
    offset = boundary["start"] / SAMPLE_RATE
    chunk_end = boundary["end"] / SAMPLE_RATE
    chunk_audio = audio[boundary["start"] : boundary["end"]]
    logger.info("chunk %d started: %.1fs-%.1fs (%.1fs)", index, offset, chunk_end, chunk_end - offset)
    chunk_started = time.monotonic()
    segments_iter, info = model.transcribe(chunk_audio, language=language, vad_filter=True)
    segments = [(seg.start + offset, seg.end + offset, seg.text) for seg in segments_iter]
    logger.info(
        "chunk %d complete: %.1fs-%.1fs, %d segment(s), language=%s (%.2f), elapsed=%.1fs",
        index,
        offset,
        chunk_end,
        len(segments),
        info.language,
        info.language_probability,
        time.monotonic() - chunk_started,
    )
    return segments, info


def _transcribe(tmp_path: str, language: Optional[str]) -> TranscribeResponse:
    logger.info(
        "transcription started: %s (language hint: %s)", tmp_path, language or "auto-detect"
    )
    started = time.monotonic()
    try:
        # Decoded once: slicing this one array per chunk is what keeps per-chunk memory (VAD +
        # feature extraction) bounded, instead of running those steps over the whole file at once.
        decode_started = time.monotonic()
        audio = decode_audio(tmp_path, sampling_rate=SAMPLE_RATE)
        duration = len(audio) / SAMPLE_RATE
        logger.info(
            "decode complete: %.1fs audio, %.2fs to decode", duration, time.monotonic() - decode_started
        )

        chunks = get_speech_timestamps(
            audio,
            VadOptions(
                max_speech_duration_s=_CHUNK_TARGET_SECONDS,
                min_silence_duration_ms=_CHUNK_MIN_SILENCE_MS,
            ),
        )
        if not chunks:
            chunks = [{"start": 0, "end": len(audio)}]
        logger.info(
            "chunk plan: %d chunk(s) for %.1fs audio (target=%ds, min_silence=%dms, concurrency=%d)",
            len(chunks),
            duration,
            _CHUNK_TARGET_SECONDS,
            _CHUNK_MIN_SILENCE_MS,
            MAX_CONCURRENT_CHUNKS,
        )

        # Boundaries sit in silence (VadOptions above), so chunks don't overlap and results can
        # just be concatenated in order -- no stitching/dedup needed across the cut points.
        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_CHUNKS) as pool:
            results = list(
                pool.map(
                    lambda item: _transcribe_chunk(item[0], item[1], audio, language),
                    enumerate(chunks),
                )
            )

        segments = []
        for chunk_segments, _ in results:
            for start, end, text in chunk_segments:
                segments.append(WhisperSegment(id=len(segments), start=start, end=end, text=text))
        # First chunk's detection stands in for the whole file; when `language` is forced this is
        # the same value for every chunk anyway.
        info = results[0][1]
    finally:
        os.remove(tmp_path)
    logger.info(
        "transcription complete: language=%s duration=%.1fs chunks=%d segments=%d elapsed=%.1fs",
        info.language,
        duration,
        len(chunks),
        len(segments),
        time.monotonic() - started,
    )
    return TranscribeResponse(
        language=info.language,
        languageProbability=info.language_probability,
        duration=duration,
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
