import json
import logging

import litellm

from caption_generator.providers.multilingual.base import MultilingualProvider
from caption_generator.segment import Segment

logger = logging.getLogger(__name__)

# reasoning_effort below is only a valid param for reasoning models (verified:
# azure/gpt-5-mini supports it, azure/gpt-4o-mini does not) - litellm raises
# UnsupportedParamsError for it otherwise, not a silent no-op. This makes any
# future non-reasoning model swap fail safe (param dropped) instead of erroring.
litellm.drop_params = True

_SYSTEM_PROMPT = (
    "You translate video caption segments from {source_lang} to {target_lang}. "
    "You are given a JSON array of segments, each with an id and text. "
    "Return ONLY a JSON array of the same length, same ids, in the same order, "
    "with text translated to {target_lang}. Do not merge, split, or reorder segments. "
    "Preserve tone and meaning; keep translations natural and concise."
)


class LiteLLMProvider(MultilingualProvider):
    """Translates one batch of segments per call. Preserves id/start/end
    exactly — only text is sent to and replaced from the model.
    """

    def __init__(
        self,
        model: str,
        api_key: str,
        api_base: str = "",
        api_version: str = "",
        max_completion_tokens: int = 4000,
    ):
        """Initializes the provider with LiteLLM connection settings.

        Args:
            model: The LiteLLM model string (e.g. "gpt-4o", or
                "azure/<deployment>" for Azure-routed models).
            api_key: The API key for the target provider.
            api_base: Required for Azure-routed models — litellm can't infer
                the Azure resource from the API key alone. Ignored by
                litellm for plain (non-"azure/"-prefixed) models.
            api_version: Required alongside api_base for Azure-routed models.
            max_completion_tokens: Passed as max_completion_tokens (not
                max_tokens) since reasoning models like gpt-5-mini spend part
                of this budget on hidden reasoning tokens before the visible
                JSON reply — too low a value truncates the reply mid-string,
                which fails json.loads below. Reasoning effort is separately
                capped via reasoning_effort below — without that, reasoning
                can consume the ENTIRE budget and return an empty string
                instead of a truncated one, also failing json.loads.
        """
        self._model = model
        self._api_key = api_key
        self._api_base = api_base
        self._api_version = api_version
        self._max_completion_tokens = max_completion_tokens

    def translate(self, segments: list[Segment], source_lang: str, target_lang: str) -> list[Segment]:
        """Translates one batch of segments via a single LiteLLM completion call.

        Preserves id/start/end exactly — only text is sent to and replaced
        from the model.

        Args:
            segments: The segments to translate, in order.
            source_lang: The source language code.
            target_lang: The target language code.

        Returns:
            A new list of segments, same ids/timings/order as the input,
            with text translated to target_lang.

        Raises:
            Exception: If the underlying LiteLLM completion call fails.
            json.JSONDecodeError: If the model's response isn't valid JSON.
            ValueError: If the translated segment ids don't match the input
                segment ids.
        """
        input_payload = [{"id": s.id, "text": s.text} for s in segments]
        logger.info(
            "Translating segment batch",
            extra={"model": self._model, "source_lang": source_lang, "target_lang": target_lang, "segment_count": len(segments)},
        )

        try:
            response = litellm.completion(
                model=self._model,
                api_key=self._api_key,
                api_base=self._api_base or None,
                api_version=self._api_version or None,
                max_completion_tokens=self._max_completion_tokens,
                # A straight translation task needs no deep reasoning —
                # capping this keeps hidden reasoning tokens from eating the
                # whole max_completion_tokens budget and leaving nothing for
                # the actual reply.
                reasoning_effort="minimal",
                messages=[
                    {
                        "role": "system",
                        "content": _SYSTEM_PROMPT.format(source_lang=source_lang, target_lang=target_lang),
                    },
                    {"role": "user", "content": json.dumps(input_payload)},
                ],
            )
        except Exception as e:
            logger.error(
                "LiteLLM translation call failed: %s: %s",
                type(e).__name__,
                str(e)[:500],
                extra={"model": self._model, "target_lang": target_lang, "segment_count": len(segments)},
            )
            raise

        translated = json.loads(response.choices[0].message.content)
        translated_by_id = {item["id"]: item["text"] for item in translated}

        if set(translated_by_id.keys()) != {s.id for s in segments}:
            logger.error(
                "Translated segment ids do not match input segment ids",
                extra={"expected_ids": [s.id for s in segments], "received_ids": list(translated_by_id.keys())},
            )
            raise ValueError("Translated segment ids do not match input segment ids")

        logger.debug("Translation batch complete", extra={"target_lang": target_lang, "segment_count": len(segments)})
        return [
            Segment(id=s.id, start=s.start, end=s.end, text=translated_by_id[s.id]) for s in segments
        ]
