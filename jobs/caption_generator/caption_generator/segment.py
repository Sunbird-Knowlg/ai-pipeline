from dataclasses import asdict, dataclass


@dataclass
class Segment:
    id: int
    start: float
    end: float
    text: str


def segments_to_dicts(segments: list[Segment]) -> list[dict]:
    return [asdict(s) for s in segments]


def segments_from_dicts(raw: list[dict]) -> list[Segment]:
    return [Segment(id=r["id"], start=r["start"], end=r["end"], text=r["text"]) for r in raw]
