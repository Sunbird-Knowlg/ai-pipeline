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
    """Returns the full English name for an ISO 639-1 code, or the code
    itself if unknown (never raises — always safe to embed in a
    `language` array field)."""
    return LANGUAGE_NAMES.get(code, code)
