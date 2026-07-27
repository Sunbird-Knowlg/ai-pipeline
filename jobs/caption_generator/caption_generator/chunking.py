import logging

from caption_generator.segment import Segment

logger = logging.getLogger(__name__)


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
    logger.debug(
        "Chunked segments",
        extra={"segment_count": len(segments), "batch_count": len(batches), "batch_size": batch_size, "overlap": overlap},
    )
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
    merged = [seen[i] for i in sorted(seen)]
    logger.debug("Merged translated batches", extra={"batch_count": len(batches), "merged_count": len(merged)})
    return merged
