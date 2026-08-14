---
paths:
  - "jobs/caption_generator/caption_generator/providers/**"
---

# Provider extensibility pattern

- `TranscriptionProvider`/`MultilingualProvider` (`providers/transcription/base.py`,
  `providers/multilingual/base.py`) are `ABC`s with one `@abstractmethod` each
  (`transcribe`/`translate`). Any new provider **must** subclass the relevant ABC and implement
  that method — don't add a "provider-ish" class that skips the ABC.
- New providers are registered in `providers/factory.py`'s `_TRANSCRIPTION_PROVIDERS`/
  `_MULTILINGUAL_PROVIDERS` dicts (class objects as values, looked up by the config string in
  `transcription.provider`/`multilingual.provider` and called with `**kwargs` to construct).
  Adding a provider is "one new class + one new dict entry" — never add an `if/elif` chain
  branching on provider name anywhere else in the codebase; that defeats the point of the
  factory.
- Pipeline code (`transcription_function.py`, `multilingual_function.py`) depends only on the
  ABC type, never a concrete provider class — this is what makes the pipeline functions
  provider-agnostic. Don't add concrete-provider-specific branches into pipeline code; if a
  provider needs special handling, that belongs inside the provider class itself.
- `LiteLLMProvider.translate` validates the LLM's response (segment id set must exactly match
  the input) before trusting it — treat any new LLM-backed provider's output as an untrusted
  boundary the same way; validate structurally before returning it to the pipeline.
