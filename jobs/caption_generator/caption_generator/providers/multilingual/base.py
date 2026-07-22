from abc import ABC, abstractmethod

from caption_generator.segment import Segment


class MultilingualProvider(ABC):
    @abstractmethod
    def translate(self, segments: list[Segment], source_lang: str, target_lang: str) -> list[Segment]:
        raise NotImplementedError
