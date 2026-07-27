import logging
import subprocess

logger = logging.getLogger(__name__)


def extract_audio(video_path: str, audio_path: str) -> None:
    """Audio-only extraction is 10-20x smaller than video — cuts both
    download size on retry and faster-whisper processing time.
    """
    logger.info("Extracting audio", extra={"video_path": video_path, "audio_path": audio_path})
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", audio_path],
        capture_output=True,
    )
    if result.returncode != 0:
        logger.error(
            "ffmpeg audio extraction failed",
            extra={"video_path": video_path, "audio_path": audio_path, "returncode": result.returncode},
        )
        raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr.decode(errors='replace')}")
    logger.debug("Audio extraction complete", extra={"audio_path": audio_path})
