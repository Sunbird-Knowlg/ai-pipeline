from caption_generator.sync import is_ecar_ready


def _transcript(language_code, status, source_language=False):
    return {"languageCode": language_code, "status": status, "sourceLanguage": source_language}


def test_empty_transcripts_not_ready():
    assert is_ecar_ready([]) is False


def test_no_source_language_transcript_not_ready():
    transcripts = [_transcript("hi", "Live")]
    assert is_ecar_ready(transcripts) is False


def test_source_not_live_blocks():
    transcripts = [
        _transcript("en", "Review", source_language=True),
        _transcript("hi", "Live"),
    ]
    assert is_ecar_ready(transcripts) is False


def test_all_live_is_ready():
    transcripts = [
        _transcript("en", "Live", source_language=True),
        _transcript("hi", "Live"),
        _transcript("ta", "Live"),
    ]
    assert is_ecar_ready(transcripts) is True


def test_draft_blocks_regardless_of_allow_failed():
    transcripts = [
        _transcript("en", "Live", source_language=True),
        _transcript("hi", "Draft"),
    ]
    assert is_ecar_ready(transcripts, allow_failed_languages=True) is False
    assert is_ecar_ready(transcripts, allow_failed_languages=False) is False


def test_review_blocks():
    transcripts = [
        _transcript("en", "Live", source_language=True),
        _transcript("hi", "Review"),
    ]
    assert is_ecar_ready(transcripts) is False


def test_processing_blocks():
    transcripts = [
        _transcript("en", "Live", source_language=True),
        _transcript("hi", "Processing"),
    ]
    assert is_ecar_ready(transcripts) is False


def test_failed_language_allowed_by_default():
    transcripts = [
        _transcript("en", "Live", source_language=True),
        _transcript("hi", "Live"),
        _transcript("ta", "Failed"),
    ]
    assert is_ecar_ready(transcripts, allow_failed_languages=True) is True


def test_failed_language_blocks_when_disallowed():
    transcripts = [
        _transcript("en", "Live", source_language=True),
        _transcript("hi", "Live"),
        _transcript("ta", "Failed"),
    ]
    assert is_ecar_ready(transcripts, allow_failed_languages=False) is False
