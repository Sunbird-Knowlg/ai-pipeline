from abc import ABC, abstractmethod

from caption_generator.segment import Segment


class MultilingualProvider(ABC):
    """Abstract interface for translating caption segments between languages."""

    @abstractmethod
    def translate(self, segments: list[Segment], source_lang: str, target_lang: str) -> list[Segment]:
        """Translates a batch of segments from source_lang to target_lang.

        Args:
            segments: The segments to translate, in order.
            source_lang: The source language code.
            target_lang: The target language code.

        Returns:
            A new list of segments, same ids/timings/order as the input,
            with text translated to target_lang.
        """
        raise NotImplementedError
