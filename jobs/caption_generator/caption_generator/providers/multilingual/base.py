from abc import ABC, abstractmethod

from caption_generator.segment import Segment


class MultilingualProvider(ABC):
    """Abstract interface for translating caption segments between languages."""

    @abstractmethod
    def translate(
        self, segments: list[Segment], source_lang: str, target_lang: str
    ) -> tuple[list[Segment], bool]:
        """Translates a batch of segments from source_lang to target_lang.

        Args:
            segments: The segments to translate, in order.
            source_lang: The source language code.
            target_lang: The target language code.

        Returns:
            A tuple of (segments, had_fallback). segments has the same
            ids/timings/order as the input, with text translated to
            target_lang where the model provided it. had_fallback is True
            if any segment fell back to its original (untranslated) text —
            callers must not auto-approve a batch where this is True, since
            it means the caption track would go live partially in the
            source language with no other signal that happened.
        """
        raise NotImplementedError
