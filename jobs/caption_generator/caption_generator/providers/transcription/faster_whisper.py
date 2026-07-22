from faster_whisper import WhisperModel

from caption_generator.providers.transcription.base import TranscriptionProvider
from caption_generator.segment import Segment


class FasterWhisperProvider(TranscriptionProvider):
    """Default transcription provider. VAD filter skips silence segments —
    reduces output noise and processing time 20-40%.
    """

    def __init__(self, model: str, device: str = "cpu", compute_type: str = "int8"):
        self._model = WhisperModel(model, device=device, compute_type=compute_type)

    def transcribe(self, audio_path: str) -> list[Segment]:
        raw_segments, _info = self._model.transcribe(audio_path, vad_filter=True)
        return [
            Segment(id=i, start=seg.start, end=seg.end, text=seg.text.strip())
            for i, seg in enumerate(raw_segments)
        ]
