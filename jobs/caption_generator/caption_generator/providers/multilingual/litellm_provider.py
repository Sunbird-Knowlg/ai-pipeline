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
    "You are given a JSON object mapping segment id -> text. "
    "Return ONLY a JSON object with the exact same keys, each value replaced by "
    "its translation to {target_lang}. Never add, remove, or rename keys — one "
    "translated value per input key, nothing else. Do not merge or split segments; "
    "each key's translation must stand alone. Preserve tone and meaning; keep "
    "translations natural and concise."
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

    def translate(
        self, segments: list[Segment], source_lang: str, target_lang: str
    ) -> tuple[list[Segment], bool]:
        """Translates one batch of segments via a single LiteLLM completion call.

        Preserves id/start/end exactly — only text is sent to and replaced
        from the model.

        Args:
            segments: The segments to translate, in order.
            source_lang: The source language code.
            target_lang: The target language code.

        Returns:
            A tuple of (segments, had_fallback) — see MultilingualProvider.translate.

        Raises:
            Exception: If the underlying LiteLLM completion call fails.
            json.JSONDecodeError: If the model's response isn't valid JSON.
            ValueError: If the response has no overlap with the batch's ids
                at all (nothing usable) — a response with SOME matching ids
                falls back to the original text for the ones that don't
                match, signaled via had_fallback rather than raising, since
                that's real partial progress worth keeping.
        """
        # Keyed by str(id) rather than an array of {id, text} objects — a
        # dict survives the model reordering/dropping/adding entries far
        # more gracefully than an array, where any length/order slip corrupts
        # every subsequent item's id association.
        input_payload = {str(s.id): s.text for s in segments}
        logger.info(
            "Translating segment batch",
            extra={
                "model": self._model,
                "source_lang": source_lang,
                "target_lang": target_lang,
                "segment_count": len(segments),
            },
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
                # Forces a valid JSON object reply (no prose wrapper, no
                # markdown fencing) instead of relying on the model to follow
                # "return only JSON" in plain text.
                response_format={"type": "json_object"},
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

        translated_by_id = json.loads(response.choices[0].message.content)

        expected_ids = {str(s.id) for s in segments}
        received_ids = set(translated_by_id.keys())
        matched_ids = expected_ids & received_ids
        if not matched_ids:
            raise ValueError(
                f"Translation response had no overlap with the batch's ids "
                f"(target_lang={target_lang}, expected={sorted(expected_ids)}, "
                f"received={sorted(received_ids)})"
            )

        missing_ids = expected_ids - received_ids
        extra_ids = received_ids - expected_ids
        had_fallback = bool(missing_ids)
        if missing_ids or extra_ids:
            # Logged in the message text itself, not just extra= — extra
            # fields have not been reliably showing up in this deployment's
            # stdout, and this is exactly the detail needed to tell an
            # occasional model slip from a systemic prompt/parsing bug.
            logger.warning(
                "Translated segment ids partially mismatched (target_lang=%s, missing=%s, extra=%s) "
                "- falling back to original text for missing ids",
                target_lang,
                sorted(missing_ids),
                sorted(extra_ids),
            )

        logger.debug(
            "Translation batch complete",
            extra={"target_lang": target_lang, "segment_count": len(segments)},
        )
        translated_segments = [
            Segment(
                id=s.id,
                start=s.start,
                end=s.end,
                text=translated_by_id.get(str(s.id), s.text),
            )
            for s in segments
        ]
        return translated_segments, had_fallback
