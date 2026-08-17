from caption_generator.chunking import chunk_segments, merge_translated_batches
from caption_generator.segment import Segment


def _segments(n):
    return [Segment(id=i, start=float(i), end=float(i + 1), text=f"text {i}") for i in range(n)]


def test_chunk_segments_empty():
    assert chunk_segments([], batch_size=80, overlap=2) == []


def test_chunk_segments_single_batch_when_smaller_than_batch_size():
    segments = _segments(10)
    batches = chunk_segments(segments, batch_size=80, overlap=2)
    assert len(batches) == 1
    assert batches[0] == segments


def test_chunk_segments_overlap_boundary():
    segments = _segments(10)
    batches = chunk_segments(segments, batch_size=4, overlap=2)

    # step = 4 - 2 = 2
    assert [s.id for s in batches[0]] == [0, 1, 2, 3]
    assert [s.id for s in batches[1]] == [2, 3, 4, 5]
    assert [s.id for s in batches[2]] == [4, 5, 6, 7]
    assert [s.id for s in batches[3]] == [6, 7, 8, 9]


def test_merge_translated_batches_dedupes_by_id_keeping_first():
    batch1 = [
        Segment(id=0, start=0.0, end=1.0, text="a"),
        Segment(id=1, start=1.0, end=2.0, text="b"),
    ]
    batch2 = [
        Segment(id=1, start=1.0, end=2.0, text="b-context-copy"),
        Segment(id=2, start=2.0, end=3.0, text="c"),
    ]

    merged = merge_translated_batches([batch1, batch2])

    assert [s.id for s in merged] == [0, 1, 2]
    assert merged[1].text == "b"
