import logging

from faster_whisper import WhisperModel

from caption_generator.providers.transcription.base import TranscriptionProvider
from caption_generator.segment import Segment

logger = logging.getLogger(__name__)


class FasterWhisperProvider(TranscriptionProvider):
    """Default transcription provider. VAD filter skips silence segments —
    reduces output noise and processing time 20-40%.
    """

    def __init__(
        self,
        model: str,
        device: str = "cpu",
        compute_type: str = "int8",
        language_detection_segments: int = 8,
        language_detection_threshold: float = 0.7,
    ):
        logger.info("Loading whisper model", extra={"model": model, "device": device, "compute_type": compute_type})
        self._model = WhisperModel(model, device=device, compute_type=compute_type)
        self._language_detection_segments = language_detection_segments
        self._language_detection_threshold = language_detection_threshold

    def transcribe(self, audio_path: str) -> tuple[list[Segment], list[Segment], str]:
        logger.info("Transcribing audio", extra={"audio_path": audio_path})
        # word_timestamps=True adds a .words list (per-word start/end) to
        # each segment — needed for word-level VTT cues; sentence-level
        # segments are still returned separately for the transcript.json /
        # translation-chunking path, which needs sentence context, not words.
        # language_detection_segments samples that many ~30s windows spread
        # across the audio (VAD-preferring speech) and majority-votes across
        # them instead of trusting a single window — lower-resource languages
        # (e.g. Kannada) are more likely to get misdetected as a major
        # language from just one or two windows, especially if those windows
        # happen to catch music/noise rather than clear speech.
        raw_segments, info = self._model.transcribe(
            audio_path,
            vad_filter=True,
            word_timestamps=True,
            language_detection_segments=self._language_detection_segments,
            language_detection_threshold=self._language_detection_threshold,
        )
        segments = []
        words = []
        for i, seg in enumerate(raw_segments):
            segments.append(Segment(id=i, start=seg.start, end=seg.end, text=seg.text.strip()))
            for word in seg.words:
                words.append(Segment(id=len(words), start=word.start, end=word.end, text=word.word.strip()))
        logger.info(
            "Transcription complete",
            extra={
                "audio_path": audio_path,
                "detected_language": info.language,
                "segment_count": len(segments),
                "word_count": len(words),
            },
        )
        return segments, words, info.language
