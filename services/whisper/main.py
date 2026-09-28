import os
import tempfile
from pathlib import Path
from typing import Optional

import httpx
import yt_dlp
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel

app = FastAPI(title="Whisper Transcription Service")

# ponytail: lazy singleton — reload only if model_size/device/compute_type change via env restart
_model: Optional[WhisperModel] = None
_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(_MODEL_SIZE, device=_DEVICE, compute_type=_COMPUTE_TYPE)
    return _model


def to_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def to_vtt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02}:{m:02}:{s:02}.{ms:03}"


def segments_to_srt(segments) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{to_srt_time(seg.start)} --> {to_srt_time(seg.end)}")
        lines.append(seg.text.strip())
        lines.append("")
    return "\n".join(lines)


def segments_to_vtt(segments) -> str:
    lines = ["WEBVTT", ""]
    for seg in segments:
        lines.append(f"{to_vtt_time(seg.start)} --> {to_vtt_time(seg.end)}")
        lines.append(seg.text.strip())
        lines.append("")
    return "\n".join(lines)


def segments_to_json(segments) -> list[dict]:
    return [
        {"id": i, "start": seg.start, "end": seg.end, "text": seg.text.strip()}
        for i, seg in enumerate(segments)
    ]


YT_DOMAINS = ("youtube.com", "youtu.be", "youtube-nocookie.com")


def is_yt_url(url: str) -> bool:
    return any(d in url for d in YT_DOMAINS)


def download_file(url: str, cookies_file: Optional[str] = None) -> str:
    """Download url to a temp file, return path. Caller must unlink."""
    if is_yt_url(url):
        tmp_dir = tempfile.mkdtemp()
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp_dir, "audio.%(ext)s"),
            "quiet": True,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
            }],
        }
        if cookies_file:
            ydl_opts["cookiefile"] = cookies_file
        else:
            ydl_opts["cookiesfrombrowser"] = ("chrome",)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        files = list(Path(tmp_dir).iterdir())
        if not files:
            raise RuntimeError("yt-dlp downloaded nothing — YouTube may be blocking this request. Try passing cookies_file.")
        return str(files[0])
    else:
        with httpx.Client(follow_redirects=True, timeout=300) as client:
            resp = client.get(url)
            resp.raise_for_status()
        suffix = Path(url.split("?")[0]).suffix or ".tmp"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(resp.content)
            return f.name


@app.post("/transcribe")
async def transcribe(
    url: str = Query(..., description="URL of audio/video or YouTube link"),
    fmt: str = Query("json", description="Output format: json, srt or vtt"),
    language: str = Query(None, description="Language code (auto-detect if omitted)"),
    cookies_file: str = Query(None, description="Path to Netscape-format cookies.txt (for YouTube auth)"),
):
    import asyncio
    loop = asyncio.get_event_loop()
    tmp_path = await loop.run_in_executor(None, download_file, url, cookies_file)

    try:
        model = get_model()
        kwargs = {"beam_size": 5, "vad_filter": True}
        if language:
            kwargs["language"] = language

        segments, info = model.transcribe(tmp_path, **kwargs)
        segments = list(segments)  # consume generator before file deleted

        if fmt.lower() == "vtt":
            return PlainTextResponse(content=segments_to_vtt(segments), media_type="text/vtt")
        if fmt.lower() == "srt":
            return PlainTextResponse(content=segments_to_srt(segments), media_type="text/plain")
        return JSONResponse(content={
            "language": info.language,
            "languageProbability": info.language_probability,
            "duration": info.duration,
            "segments": segments_to_json(segments),
        })
    finally:
        os.unlink(tmp_path)


@app.get("/health")
def health():
    return {"status": "ok", "model": _MODEL_SIZE, "device": _DEVICE}
