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
from urllib.parse import urlparse

import av
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
# Bounds how many whole-file transcriptions run at once in this pod, independent of per-chunk
# concurrency above -- a burst of invocations (e.g. a trigger replaying a topic's retained
# backlog on first deploy) would otherwise decode+VAD every file at once, each holding its own
# whole-file memory, with nothing to queue the overflow.
MAX_CONCURRENT_TRANSCRIPTIONS = int(os.environ.get("WHISPER_MAX_CONCURRENT_TRANSCRIPTIONS", "2"))
# Comma-separated hostname suffixes artifactUrl is allowed to resolve to, e.g.
# "blob.core.windows.net". Empty means no allowlist is enforced (every https host is accepted) --
# set this in production, where the real storage account's domain is known.
ALLOWED_ARTIFACT_HOST_SUFFIXES = tuple(
    s.strip()
    for s in os.environ.get("WHISPER_ALLOWED_ARTIFACT_HOST_SUFFIXES", "").split(",")
    if s.strip()
)

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
# as a real boundary rather than the forced "split at the last silence over ~100ms" fallback.
_CHUNK_TARGET_SECONDS = _METADATA["config"]["chunkTargetSeconds"]
_CHUNK_MIN_SILENCE_MS = _METADATA["config"]["chunkMinSilenceMs"]
# Speech shorter than this is VAD noise (breaths, clicks), not worth its own region -- merged away
# before chunk-merging runs, so it doesn't fragment the chunk plan into one region per blip.
_MIN_SPEECH_DURATION_MS = 250
# How much audio detect_language() looks at to decide the source language once, up front, instead
# of every chunk re-detecting from its own short, padded window (each of which can hallucinate or
# land on a different language/script). ~30s per segment.
_LANGUAGE_DETECTION_SEGMENTS = 3

_transcription_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSCRIPTIONS)


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


def _strip_query(url: str) -> str:
    """A SAS token or other credential can live in the query string -- never log or journal it."""
    return url.split("?", 1)[0]


def _validate_artifact_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise TerminalError(f"artifactUrl must be https: {_strip_query(url)}")
    if ALLOWED_ARTIFACT_HOST_SUFFIXES and not (
        parsed.hostname and parsed.hostname.endswith(ALLOWED_ARTIFACT_HOST_SUFFIXES)
    ):
        raise TerminalError(f"artifactUrl host not allowed: {parsed.hostname}")


# A download failure in one of these ranges is the origin being slow or temporarily unavailable,
# not a permanently bad request -- worth Restate retrying, same as a 5xx.
_RETRYABLE_DOWNLOAD_STATUSES = {408, 425, 429}


def _download(artifact_url: str) -> str:
    safe_url = _strip_query(artifact_url)
    logger.info("download started: %s", safe_url)
    started = time.monotonic()
    suffix = os.path.splitext(safe_url)[1] or ".media"
    tmp_path: Optional[str] = None
    # 30s to connect/get headers, 120s per read -- bounds a stalled origin instead of blocking this
    # worker thread forever (Restate's own abort frees the invocation, not the thread underneath).
    timeout = httpx.Timeout(30.0, read=120.0)
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, max_redirects=5) as client:
            with client.stream("GET", artifact_url) as response:
                if response.status_code != 200:
                    logger.error(
                        "download failed: %s -> HTTP %d", safe_url, response.status_code
                    )
                    message = f"failed to fetch {safe_url}: {response.status_code}"
                    if (
                        response.status_code in _RETRYABLE_DOWNLOAD_STATUSES
                        or response.status_code >= 500
                    ):
                        raise RuntimeError(message)
                    raise TerminalError(message)
                total_bytes = 0
                # Streamed to disk rather than buffered via response.content: the old version held
                # the whole artifact in RAM before writing it out, doubling peak memory for no reason.
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                    tmp_path = tmp.name
                    for data in response.iter_bytes():
                        tmp.write(data)
                        total_bytes += len(data)
    except BaseException:
        # A connection reset, disk-full, or any other failure mid-write leaves a partial file on
        # disk with delete=False; without this, a flaky multi-GB download retried many times could
        # fill the pod's ephemeral storage with orphaned partial downloads.
        if tmp_path is not None and os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    logger.info(
        "download complete: %s (%.1f MB, %.2fs)",
        tmp_path,
        total_bytes / 1_000_000,
        time.monotonic() - started,
    )
    return tmp_path


def _merge_regions(regions: list[dict], target_samples: float) -> list[dict]:
    """Merges consecutive VAD speech regions up to ~target_samples long, cutting only at the gaps
    VAD already found (never mid-speech). get_speech_timestamps on its own only caps a region's
    length -- it never grows short regions back toward that cap, so a lecture with frequent
    pauses otherwise comes back as roughly one region per pause, far short of the target."""
    if not regions:
        return []
    merged = [dict(regions[0])]
    for region in regions[1:]:
        last = merged[-1]
        if region["end"] - last["start"] <= target_samples:
            last["end"] = region["end"]
        else:
            merged.append(dict(region))
    return merged


def _detect_language(audio) -> tuple[str, float]:
    language, probability, _ = model.detect_language(
        audio, vad_filter=True, language_detection_segments=_LANGUAGE_DETECTION_SEGMENTS
    )
    logger.info("language detected: %s (%.2f)", language, probability)
    return language, probability


def _transcribe_chunk(index: int, boundary: dict, audio, language: str) -> list[tuple[float, float, str]]:
    """Transcribes one VAD-bounded slice of the already-decoded audio array. Runs on a worker
    thread (see _transcribe's ThreadPoolExecutor) -- CTranslate2 releases the GIL during inference,
    and num_workers on the model (set at startup) lets these calls actually run concurrently
    instead of queuing behind each other. `language` is always forced here (decided once up
    front, not per chunk): a short, padded chunk window is exactly where language auto-detection
    is least reliable, and letting it vary per chunk reset translation/transcription context at
    every cut."""
    offset = boundary["start"] / SAMPLE_RATE
    chunk_end = boundary["end"] / SAMPLE_RATE
    chunk_audio = audio[boundary["start"] : boundary["end"]]
    logger.info("chunk %d started: %.1fs-%.1fs (%.1fs)", index, offset, chunk_end, chunk_end - offset)
    chunk_started = time.monotonic()
    segments_iter, _ = model.transcribe(chunk_audio, language=language, vad_filter=True)
    segments = [(seg.start + offset, seg.end + offset, seg.text) for seg in segments_iter]
    logger.info(
        "chunk %d complete: %.1fs-%.1fs, %d segment(s), elapsed=%.1fs",
        index,
        offset,
        chunk_end,
        len(segments),
        time.monotonic() - chunk_started,
    )
    return segments


def _transcribe(tmp_path: str, language: Optional[str]) -> TranscribeResponse:
    logger.info(
        "transcription started: %s (language hint: %s)", tmp_path, language or "auto-detect"
    )
    started = time.monotonic()
    try:
        # Decoded once: slicing this one array per chunk is what keeps per-chunk memory (VAD +
        # feature extraction) bounded, instead of running those steps over the whole file at once.
        decode_started = time.monotonic()
        try:
            audio = decode_audio(tmp_path, sampling_rate=SAMPLE_RATE)
        except (IndexError, av.error.InvalidDataError) as error:
            # No audio track, or a 200 response that isn't actually media -- permanent either way;
            # retrying would just re-download and fail the same way again.
            raise TerminalError(f"cannot decode media: {error}") from error
        duration = len(audio) / SAMPLE_RATE
        logger.info(
            "decode complete: %.1fs audio, %.2fs to decode", duration, time.monotonic() - decode_started
        )

        detected_probability = 1.0
        if language is None:
            language, detected_probability = _detect_language(audio)

        raw_regions = get_speech_timestamps(
            audio,
            VadOptions(
                min_speech_duration_ms=_MIN_SPEECH_DURATION_MS,
                max_speech_duration_s=_CHUNK_TARGET_SECONDS,
                min_silence_duration_ms=_CHUNK_MIN_SILENCE_MS,
            ),
        )
        chunks = _merge_regions(raw_regions, target_samples=_CHUNK_TARGET_SECONDS * SAMPLE_RATE)
        if not chunks:
            chunks = [{"start": 0, "end": len(audio)}]
        logger.info(
            "chunk plan: %d chunk(s) for %.1fs audio (%d raw VAD region(s), target=%ds, "
            "min_silence=%dms, concurrency=%d)",
            len(chunks),
            duration,
            len(raw_regions),
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
        for chunk_segments in results:
            for start, end, text in chunk_segments:
                segments.append(WhisperSegment(id=len(segments), start=start, end=end, text=text))
    finally:
        os.remove(tmp_path)
    logger.info(
        "transcription complete: language=%s duration=%.1fs chunks=%d segments=%d elapsed=%.1fs",
        language,
        duration,
        len(chunks),
        len(segments),
        time.monotonic() - started,
    )
    return TranscribeResponse(
        language=language,
        languageProbability=detected_probability,
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
    ingress_private=_METADATA.get("visibility") == "private",
    inactivity_timeout=timedelta(minutes=5),
    abort_timeout=timedelta(minutes=_ABORT_TIMEOUT_MINUTES),
    journal_retention=timedelta(days=7),
    idempotency_retention=timedelta(days=7),
    invocation_retry_policy=restate.InvocationRetryPolicy(
        max_attempts=10,
        on_max_attempts="pause",
        initial_interval=timedelta(seconds=1),
        max_interval=timedelta(seconds=60),
    ),
)


@whisper_service.handler()
async def transcribe(ctx: Context, req: TranscribeRequest) -> TranscribeResponse:
    _validate_artifact_url(req.artifactUrl)
    # Checked here, before the download+decode step: a bad language code is permanent either way,
    # so there's no reason to pay for a full download and decode first to discover that.
    if req.language is not None and req.language not in model.supported_languages:
        raise TerminalError(f"unsupported language: {req.language}")
    logger.info("transcribe request received: artifactUrl=%s", _strip_query(req.artifactUrl))
    async with _transcription_semaphore:
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
_background_tasks: set[asyncio.Task] = set()


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
                # asyncio holds a task only weakly; without keeping a reference, the task can be
                # garbage-collected mid-run and silently stop before registering.
                task = asyncio.create_task(_register_or_die())
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    else:
        await _original_app(scope, receive, send)
