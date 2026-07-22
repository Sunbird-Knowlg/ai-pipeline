from abc import ABC, abstractmethod

from caption_generator.segment import Segment


class TranscriptionProvider(ABC):
    @abstractmethod
    def transcribe(self, audio_path: str) -> list[Segment]:
        raise NotImplementedError
