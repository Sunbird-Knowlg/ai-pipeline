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
        """Loads the faster-whisper model and stores detection settings.

        Args:
            model: The faster-whisper model name or path (e.g. "base").
            device: The compute device ("cpu" or "cuda").
            compute_type: The ctranslate2 quantization type (e.g. "int8").
            language_detection_segments: Number of 30s audio segments sampled
                to detect the source language.
            language_detection_threshold: Confidence threshold for accepting
                the top language guess before sampling more segments.
            candidate_languages: If set, restricts language detection to
                these codes only, re-ranking Whisper's per-language
                probabilities within this set instead of trusting its raw
                top-1 guess (see transcribe / detect_language below).
        """
        logger.info("Loading whisper model", extra={"model": model, "device": device, "compute_type": compute_type})
        self._model = WhisperModel(model, device=device, compute_type=compute_type)
        self._language_detection_segments = language_detection_segments
        self._language_detection_threshold = language_detection_threshold
        # Whisper's raw top-1 guess is a global argmax across ~99 languages,
        # so acoustically similar ones (e.g. Kannada vs. Tamil) can out-rank
        # the correct one; re-ranking within the known candidate set is safer.
        self._candidate_languages = set(candidate_languages) if candidate_languages else None

    def transcribe(self, audio_path: str) -> tuple[list[Segment], list[Segment], str]:
        """Transcribes an audio file into sentence and word-level segments.

        If candidate_languages was configured, first runs language detection
        and restricts the result to the highest-probability candidate before
        transcribing; otherwise lets faster-whisper auto-detect freely.

        Args:
            audio_path: Path to the audio file to transcribe.

        Returns:
            A tuple of (segments, words, detected_language_code) — segments
            are sentence-level, words are word-level (one Segment per word,
            derived from segment.words via word_timestamps=True), and
            detected_language_code is the source language faster-whisper
            settled on.
        """
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
