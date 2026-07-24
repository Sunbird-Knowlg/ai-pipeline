from faster_whisper import WhisperModel

from caption_generator.providers.transcription.base import TranscriptionProvider
from caption_generator.segment import Segment


class FasterWhisperProvider(TranscriptionProvider):
    """Default transcription provider. VAD filter skips silence segments —
    reduces output noise and processing time 20-40%.
    """

    def __init__(self, model: str, device: str = "cpu", compute_type: str = "int8"):
        self._model = WhisperModel(model, device=device, compute_type=compute_type)

    def transcribe(self, audio_path: str) -> tuple[list[Segment], list[Segment], str]:
        # word_timestamps=True adds a .words list (per-word start/end) to
        # each segment — needed for word-level VTT cues; sentence-level
        # segments are still returned separately for the transcript.json /
        # translation-chunking path, which needs sentence context, not words.
        raw_segments, info = self._model.transcribe(audio_path, vad_filter=True, word_timestamps=True)
        segments = []
        words = []
        for i, seg in enumerate(raw_segments):
            segments.append(Segment(id=i, start=seg.start, end=seg.end, text=seg.text.strip()))
            for word in seg.words:
                words.append(Segment(id=len(words), start=word.start, end=word.end, text=word.word.strip()))
        return segments, words, info.language
