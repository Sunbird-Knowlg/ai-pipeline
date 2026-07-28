import logging

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

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
        candidate_languages: list[str] | None = None,
    ):
        logger.info("Loading whisper model", extra={"model": model, "device": device, "compute_type": compute_type})
        self._model = WhisperModel(model, device=device, compute_type=compute_type)
        self._language_detection_segments = language_detection_segments
        self._language_detection_threshold = language_detection_threshold
        # Whisper's own top-1 guess is a global argmax across ~99 languages —
        # acoustically similar languages (e.g. Kannada vs. Tamil, both
        # Dravidian) can easily out-rank the correct one at low confidence.
        # Restricting to the platform's actual supported languages and
        # re-ranking within just that set is far more reliable than raising
        # language_detection_segments further once confidence is already low
        # (see detect_language's all_language_probs — the full distribution,
        # not just the winner).
        self._candidate_languages = set(candidate_languages) if candidate_languages else None

    def transcribe(self, audio_path: str) -> tuple[list[Segment], list[Segment], str]:
        logger.info("Transcribing audio", extra={"audio_path": audio_path})
        audio = decode_audio(audio_path)

        language = None
        if self._candidate_languages:
            _, _, all_language_probs = self._model.detect_language(
                audio=audio,
                vad_filter=True,
                language_detection_segments=self._language_detection_segments,
                language_detection_threshold=self._language_detection_threshold,
            )
            candidates = [(lang, prob) for lang, prob in all_language_probs if lang in self._candidate_languages]
            if candidates:
                language = max(candidates, key=lambda pair: pair[1])[0]
                logger.info(
                    "Restricted language detection to candidate set",
                    extra={"audio_path": audio_path, "chosen_language": language, "top_candidates": candidates[:5]},
                )

        # word_timestamps=True adds a .words list (per-word start/end) to
        # each segment — needed for word-level VTT cues; sentence-level
        # segments are still returned separately for the transcript.json /
        # translation-chunking path, which needs sentence context, not words.
        raw_segments, info = self._model.transcribe(
            audio,
            language=language,
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
