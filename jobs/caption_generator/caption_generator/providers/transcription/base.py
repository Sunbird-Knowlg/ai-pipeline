from abc import ABC, abstractmethod

from caption_generator.segment import Segment


class TranscriptionProvider(ABC):
    @abstractmethod
    def transcribe(self, audio_path: str) -> tuple[list[Segment], str]:
        """Returns (segments, detected_language_code) — e.g. ("en", ...).
        The source-language Transcript node's languageCode is unknown until
        this call returns, so callers need the detected code, not just text.
        """
        raise NotImplementedError
