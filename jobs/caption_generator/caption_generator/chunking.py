"""Splits segments into overlapping batches for translation, and merges the
translated batches back into a single deduplicated sequence.
"""

import logging

from caption_generator.segment import Segment

logger = logging.getLogger(__name__)


def chunk_segments(segments: list[Segment], batch_size: int, overlap: int) -> list[list[Segment]]:
    """Splits segments into batches for the multilingual provider to translate.

    Each batch overlaps the last `overlap` segments of the previous batch, so
    the model sees trailing context and translation stays continuous across
    batch boundaries.

    Args:
        segments: The full ordered list of segments to split.
        batch_size: Maximum number of segments per batch.
        overlap: Number of trailing segments repeated at the start of the
            next batch.

    Returns:
        A list of segment batches. Empty if segments is empty.

    Raises:
        ValueError: If overlap >= batch_size (or batch_size <= 0) — step
            would be <= 0 and the loop below would never advance past the
            first batch, appending forever for any transcript longer than
            batch_size.
    """
    if not segments:
        return []

    if batch_size <= 0 or overlap >= batch_size:
        raise ValueError(
            f"overlap ({overlap}) must be < batch_size ({batch_size}), and batch_size must be > 0"
        )

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
        extra={
            "segment_count": len(segments),
            "batch_count": len(batches),
            "batch_size": batch_size,
            "overlap": overlap,
        },
    )
    return batches


def merge_translated_batches(batches: list[list[Segment]]) -> list[Segment]:
    """Merges translated batches back into a single ordered segment list.

    Dedupes overlapping segments across batches, keeping the first
    occurrence — later occurrences are just context copies for the LLM,
    not a second authoritative translation.

    Args:
        batches: Translated segment batches, as produced against the output
            of chunk_segments.

    Returns:
        The merged segments, ordered by segment id.
    """
    seen: dict[int, Segment] = {}
    for batch in batches:
        for segment in batch:
            if segment.id not in seen:
                seen[segment.id] = segment
    merged = [seen[i] for i in sorted(seen)]
    logger.debug(
        "Merged translated batches",
        extra={"batch_count": len(batches), "merged_count": len(merged)},
    )
    return merged
