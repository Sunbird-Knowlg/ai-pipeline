import subprocess


def extract_audio(video_path: str, audio_path: str) -> None:
    """Audio-only extraction is 10-20x smaller than video — cuts both
    download size on retry and faster-whisper processing time.
    """
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", audio_path],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed: {result.stderr.decode(errors='replace')}")
