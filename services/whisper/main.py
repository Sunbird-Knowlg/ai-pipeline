import os
import tempfile

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

app = FastAPI()
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)


def _format_timestamp(seconds: float, comma: bool) -> str:
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1_000)
    sep = "," if comma else "."
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def _segments_to_srt(segments: list[dict]) -> str:
    lines = []
    for i, seg in enumerate(segments, start=1):
        start = _format_timestamp(seg["start"], comma=True)
        end = _format_timestamp(seg["end"], comma=True)
        lines.append(f"{i}\n{start} --> {end}\n{seg['text'].strip()}\n")
    return "\n".join(lines)


def _segments_to_vtt(segments: list[dict]) -> str:
    lines = ["WEBVTT", ""]
    for seg in segments:
        start = _format_timestamp(seg["start"], comma=False)
        end = _format_timestamp(seg["end"], comma=False)
        lines.append(f"{start} --> {end}")
        lines.append(seg["text"].strip())
        lines.append("")
    return "\n".join(lines)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(
    url: str,
    fmt: str = Query("json", pattern="^(json|srt|vtt)$"),
    language: str | None = None,
):
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.get(url)
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail=f"failed to fetch {url}")
        suffix = os.path.splitext(url.split("?")[0])[1] or ".media"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(response.content)
            tmp_path = tmp.name

    try:
        segments_iter, info = model.transcribe(
            tmp_path,
            language=language,
            vad_filter=True,
        )
        segments = [
            {"id": i, "start": seg.start, "end": seg.end, "text": seg.text}
            for i, seg in enumerate(segments_iter)
        ]
    finally:
        os.remove(tmp_path)

    if fmt == "srt":
        return PlainTextResponse(_segments_to_srt(segments), media_type="text/plain")
    if fmt == "vtt":
        return PlainTextResponse(_segments_to_vtt(segments), media_type="text/vtt")
    return JSONResponse(
        {
            "language": info.language,
            "languageProbability": info.language_probability,
            "duration": info.duration,
            "segments": segments,
        }
    )
