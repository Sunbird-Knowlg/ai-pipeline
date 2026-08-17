from sunbird_ai_core.languages import language_name


def test_known_code_returns_full_name():
    assert language_name("en") == "English"
    assert language_name("kn") == "Kannada"


def test_unknown_code_falls_back_to_code_itself():
    assert language_name("xx") == "xx"
