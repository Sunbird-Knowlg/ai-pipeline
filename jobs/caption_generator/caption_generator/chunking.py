from caption_generator.segment import Segment


def chunk_segments(segments: list[Segment], batch_size: int, overlap: int) -> list[list[Segment]]:
    """Splits into batches of batch_size, each overlapping the last `overlap`
    segments of the previous batch for translation continuity at boundaries.
    """
    if not segments:
        return []

    step = batch_size - overlap
    batches = []
    i = 0
    while True:
        batch = segments[i : i + batch_size]
        batches.append(batch)
        if i + batch_size >= len(segments):
            break
        i += step
    return batches


def merge_translated_batches(batches: list[list[Segment]]) -> list[Segment]:
    """Dedupes overlapping segments across batches, keeping the first
    occurrence — later occurrences are just context copies for the LLM,
    not a second authoritative translation.
    """
    seen: dict[int, Segment] = {}
    for batch in batches:
        for segment in batch:
            if segment.id not in seen:
                seen[segment.id] = segment
    return [seen[i] for i in sorted(seen)]
