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
    return [asdict(s) for s in segments]


def segments_from_dicts(raw: list[dict]) -> list[Segment]:
    return [Segment(id=r["id"], start=r["start"], end=r["end"], text=r["text"]) for r in raw]
