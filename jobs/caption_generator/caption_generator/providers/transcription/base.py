from abc import ABC, abstractmethod

from caption_generator.segment import Segment


class TranscriptionProvider(ABC):
    @abstractmethod
    def transcribe(self, audio_path: str) -> tuple[list[Segment], list[Segment], str]:
        """Returns (segments, words, detected_language_code).

        segments: sentence/phrase-level, used for transcript.json and as
        translation-chunking context (needs sentence boundaries, not words).
        words: word-level (one Segment per word), used for word-per-cue VTT.
        detected_language_code: e.g. "en" — the source-language Transcript
        node's languageCode is unknown until this call returns.
        """
        raise NotImplementedError
