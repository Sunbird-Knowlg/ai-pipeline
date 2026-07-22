import json

import litellm

from caption_generator.providers.multilingual.base import MultilingualProvider
from caption_generator.segment import Segment

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

    def __init__(self, model: str, api_key: str):
        self._model = model
        self._api_key = api_key

    def translate(self, segments: list[Segment], source_lang: str, target_lang: str) -> list[Segment]:
        input_payload = [{"id": s.id, "text": s.text} for s in segments]

        response = litellm.completion(
            model=self._model,
            api_key=self._api_key,
            messages=[
                {
                    "role": "system",
                    "content": _SYSTEM_PROMPT.format(source_lang=source_lang, target_lang=target_lang),
                },
                {"role": "user", "content": json.dumps(input_payload)},
            ],
        )

        translated = json.loads(response.choices[0].message.content)
        translated_by_id = {item["id"]: item["text"] for item in translated}

        if set(translated_by_id.keys()) != {s.id for s in segments}:
            raise ValueError("Translated segment ids do not match input segment ids")

        return [
            Segment(id=s.id, start=s.start, end=s.end, text=translated_by_id[s.id]) for s in segments
        ]
