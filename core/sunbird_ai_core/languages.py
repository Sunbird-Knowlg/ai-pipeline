"""ISO 639-1 code -> full English language name, for populating Transcript's
`language` schema field (a display-name array, separate from `languageCode`
— see schemas/transcript/1.0/schema.json in knowledge-platform).
"""

LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi",
    "ta": "Tamil",
    "te": "Telugu",
    "kn": "Kannada",
    "ml": "Malayalam",
    "mr": "Marathi",
    "gu": "Gujarati",
    "bn": "Bengali",
    "pa": "Punjabi",
    "or": "Odia",
    "as": "Assamese",
    "ur": "Urdu",
    "ar": "Arabic",
    "fr": "French",
    "pt": "Portuguese",
    "es": "Spanish",
    "de": "German",
    "zh": "Chinese",
    "ja": "Japanese",
    "ru": "Russian",
    "it": "Italian",
    "ko": "Korean",
    "nl": "Dutch",
    "tr": "Turkish",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
    "sw": "Swahili",
    "ne": "Nepali",
    "si": "Sinhala",
}


def language_name(code: str) -> str:
    """Resolves an ISO 639-1 code to its full English language name.

    Never raises — always safe to embed in a `language` array field.

    Args:
        code: The ISO 639-1 language code (e.g. 'en', 'hi').

    Returns:
        The full English name for the code, or the code itself if unknown.
    """
    return LANGUAGE_NAMES.get(code, code)
