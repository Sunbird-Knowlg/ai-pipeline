import json

from caption_generator.segment import Segment, segments_from_dicts, segments_to_dicts


def _format_timestamp(seconds: float) -> str:
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    whole_secs = int(secs)
    millis = round((secs - whole_secs) * 1000)
    if millis == 1000:
        millis = 0
        whole_secs += 1
    return f"{int(hours):02d}:{int(minutes):02d}:{whole_secs:02d}.{millis:03d}"


def build_vtt(segments: list[Segment]) -> str:
    lines = ["WEBVTT", ""]
    for segment in segments:
        lines.append(f"{_format_timestamp(segment.start)} --> {_format_timestamp(segment.end)}")
        lines.append(segment.text)
        lines.append("")
    return "\n".join(lines)


def build_karaoke_vtt(sentence_segments: list[Segment], words_per_sentence: list[list[Segment]]) -> str:
    """One cue per sentence (same cue timing as build_vtt), with an inline
    WebVTT timestamp tag before every word after the first — lets a
    compatible player progressively highlight the currently-spoken word
    while still showing the full sentence. Not used by the production
    pipeline today — sample/preview tooling only (see scripts/transcribe_local.py).
    """
    lines = ["WEBVTT", ""]
    for sentence, words in zip(sentence_segments, words_per_sentence):
        lines.append(f"{_format_timestamp(sentence.start)} --> {_format_timestamp(sentence.end)}")
        cue_parts = []
        for i, word in enumerate(words):
            if i == 0:
                cue_parts.append(word.text)
            else:
                cue_parts.append(f"<{_format_timestamp(word.start)}>{word.text}")
        lines.append(" ".join(cue_parts))
        lines.append("")
    return "\n".join(lines)


def build_transcript_json(segments: list[Segment]) -> str:
    return json.dumps({"segments": segments_to_dicts(segments)})


def parse_transcript_json(raw: str) -> list[Segment]:
    payload = json.loads(raw)
    return segments_from_dicts(payload["segments"])
