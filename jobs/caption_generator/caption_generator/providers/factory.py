import logging

from caption_generator.providers.multilingual.base import MultilingualProvider
from caption_generator.providers.multilingual.litellm_provider import LiteLLMProvider
from caption_generator.providers.transcription.base import TranscriptionProvider
from caption_generator.providers.transcription.faster_whisper import FasterWhisperProvider

logger = logging.getLogger(__name__)

_TRANSCRIPTION_PROVIDERS = {
    "faster_whisper": FasterWhisperProvider,
}

_MULTILINGUAL_PROVIDERS = {
    "litellm": LiteLLMProvider,
}


def build_transcription_provider(provider_name: str, **kwargs) -> TranscriptionProvider:
    if provider_name not in _TRANSCRIPTION_PROVIDERS:
        logger.error("Unknown transcription provider requested", extra={"provider_name": provider_name})
        raise ValueError(f"Unknown transcription provider: {provider_name}")
    logger.info("Building transcription provider", extra={"provider_name": provider_name})
    return _TRANSCRIPTION_PROVIDERS[provider_name](**kwargs)


def build_multilingual_provider(provider_name: str, **kwargs) -> MultilingualProvider:
    if provider_name not in _MULTILINGUAL_PROVIDERS:
        logger.error("Unknown multilingual provider requested", extra={"provider_name": provider_name})
        raise ValueError(f"Unknown multilingual provider: {provider_name}")
    logger.info("Building multilingual provider", extra={"provider_name": provider_name})
    return _MULTILINGUAL_PROVIDERS[provider_name](**kwargs)
