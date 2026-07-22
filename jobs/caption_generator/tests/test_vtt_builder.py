from caption_generator.builders.vtt_builder import (
    build_karaoke_vtt,
    build_transcript_json,
    build_vtt,
    parse_transcript_json,
)
from caption_generator.segment import Segment


def test_build_vtt_formats_timestamps():
    segments = [
        Segment(id=0, start=10.67, end=24.671, text="Hello children"),
        Segment(id=1, start=3661.5, end=3665.0, text="One hour in"),
    ]

    vtt = build_vtt(segments)

    assert vtt.startswith("WEBVTT\n\n")
    assert "00:00:10.670 --> 00:00:24.671" in vtt
    assert "01:01:01.500 --> 01:01:05.000" in vtt
    assert "Hello children" in vtt


def test_build_vtt_millisecond_rounding_carries_seconds():
    segments = [Segment(id=0, start=0.0, end=0.9996, text="x")]

    vtt = build_vtt(segments)

    assert "00:00:00.000 --> 00:00:01.000" in vtt


def test_transcript_json_roundtrip():
    segments = [
        Segment(id=0, start=0.0, end=2.5, text="Hello"),
        Segment(id=1, start=2.5, end=5.0, text="World"),
    ]

    raw = build_transcript_json(segments)
    parsed = parse_transcript_json(raw)

    assert parsed == segments


def test_build_karaoke_vtt_one_cue_per_sentence_with_inline_word_tags():
    sentences = [Segment(id=0, start=0.0, end=2.0, text="Hello world")]
    words_per_sentence = [
        [
            Segment(id=0, start=0.0, end=0.5, text="Hello"),
            Segment(id=1, start=0.5, end=2.0, text="world"),
        ]
    ]

    vtt = build_karaoke_vtt(sentences, words_per_sentence)

    assert vtt.startswith("WEBVTT\n\n")
    # one cue for the whole sentence, not two separate cues
    assert vtt.count("-->") == 1
    assert "00:00:00.000 --> 00:00:02.000" in vtt
    # first word untagged, every later word prefixed with its own timestamp
    assert "Hello <00:00:00.500>world" in vtt


def test_build_karaoke_vtt_multiple_sentences():
    sentences = [
        Segment(id=0, start=0.0, end=1.0, text="Hi"),
        Segment(id=1, start=2.0, end=3.0, text="Bye now"),
    ]
    words_per_sentence = [
        [Segment(id=0, start=0.0, end=1.0, text="Hi")],
        [
            Segment(id=1, start=2.0, end=2.4, text="Bye"),
            Segment(id=2, start=2.4, end=3.0, text="now"),
        ],
    ]

    vtt = build_karaoke_vtt(sentences, words_per_sentence)

    assert vtt.count("-->") == 2
    assert "Bye <00:00:02.400>now" in vtt
