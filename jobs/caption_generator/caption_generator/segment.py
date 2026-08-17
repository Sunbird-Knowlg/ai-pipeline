from dataclasses import asdict, dataclass


@dataclass
class Segment:
    """A single timed caption/transcript unit (sentence or word level).

    Attributes:
        id: Stable position index, used to align a segment across
            translation batches and to detect duplicates from batch overlap.
        start: Start time in seconds.
        end: End time in seconds.
        text: The transcribed or translated text for this span.
    """

    id: int
    start: float
    end: float
    text: str


def segments_to_dicts(segments: list[Segment]) -> list[dict]:
    """Converts segments to plain dicts for JSON serialization.

    Args:
        segments: The segments to convert.

    Returns:
        One dict per segment, with the same keys as Segment's fields.
    """
    return [asdict(s) for s in segments]


def segments_from_dicts(raw: list[dict]) -> list[Segment]:
    """Reconstructs segments from the dicts produced by segments_to_dicts.

    Args:
        raw: One dict per segment, each with id/start/end/text keys.

    Returns:
        The reconstructed segments, in the same order as raw.

    Raises:
        KeyError: If any dict is missing id, start, end, or text.
    """
    return [Segment(id=r["id"], start=r["start"], end=r["end"], text=r["text"]) for r in raw]
