#!/usr/bin/env python3
"""Standalone transcription — no Flink/Kafka/JanusGraph needed.

Reuses the exact same audio extraction + provider + VTT/JSON builder logic
as the real caption-generator pipeline (S3-S5 of TranscriptionFunction),
so default output here is byte-for-byte the same format the real job
produces.

Usage:
    python scripts/transcribe_local.py path/to/video.mp4 --output-dir out/
    python scripts/transcribe_local.py path/to/video.mp4 --output-dir out/ --word-level-vtt

Produces in --output-dir:
    transcript.json           — segments array (id, start, end, text)
    captions.vtt               — WebVTT captions (sentence-level, production format)

With --word-level-vtt, additionally produces two PREVIEW-ONLY formats (not
used by the production pipeline — for the frontend team to pick from
before either one ever becomes the real format):
    captions_word_by_word.vtt — one VTT cue per individual word
    captions_karaoke.vtt      — one cue per sentence, inline per-word
                                 timestamp tags for progressive highlighting
"""
import argparse
import os

from caption_generator.audio import extract_audio
from caption_generator.builders.vtt_builder import build_karaoke_vtt, build_transcript_json, build_vtt
from caption_generator.segment import Segment
from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video_path", help="Path to local video file (mp4/webm)")
    parser.add_argument("--output-dir", default=".", help="Where to write output files")
    parser.add_argument("--model", default="large-v3-turbo", help="faster-whisper model name")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument(
        "--word-level-vtt",
        action="store_true",
        help="Also produce captions_word_by_word.vtt and captions_karaoke.vtt (preview only)",
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    audio_path = os.path.join(args.output_dir, "_audio.wav")

    print(f"Extracting audio from {args.video_path} ...")
    extract_audio(args.video_path, audio_path)

    print(f"Loading model {args.model} ({args.device}/{args.compute_type}) ...")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    print("Transcribing ...")
    raw_segments, _info = model.transcribe(
        audio_path, vad_filter=True, word_timestamps=args.word_level_vtt
    )
    raw_segments = list(raw_segments)  # materialize once — reused below for word data too
    os.remove(audio_path)

    segments = [
        Segment(id=i, start=seg.start, end=seg.end, text=seg.text.strip())
        for i, seg in enumerate(raw_segments)
    ]

    json_path = os.path.join(args.output_dir, "transcript.json")
    vtt_path = os.path.join(args.output_dir, "captions.vtt")

    with open(json_path, "w") as f:
        f.write(build_transcript_json(segments))
    with open(vtt_path, "w") as f:
        f.write(build_vtt(segments))

    print(f"\n{len(segments)} segments")
    print(f"transcript.json -> {json_path}")
    print(f"captions.vtt    -> {vtt_path}")

    if args.word_level_vtt:
        word_id = 0
        word_segments: list[Segment] = []
        words_per_sentence: list[list[Segment]] = []
        for seg in raw_segments:
            sentence_words = []
            for w in seg.words or []:
                word_seg = Segment(id=word_id, start=w.start, end=w.end, text=w.word.strip())
                word_segments.append(word_seg)
                sentence_words.append(word_seg)
                word_id += 1
            words_per_sentence.append(sentence_words)

        word_by_word_path = os.path.join(args.output_dir, "captions_word_by_word.vtt")
        karaoke_path = os.path.join(args.output_dir, "captions_karaoke.vtt")

        with open(word_by_word_path, "w") as f:
            f.write(build_vtt(word_segments))
        with open(karaoke_path, "w") as f:
            f.write(build_karaoke_vtt(segments, words_per_sentence))

        print(f"\n{len(word_segments)} words")
        print(f"captions_word_by_word.vtt -> {word_by_word_path}")
        print(f"captions_karaoke.vtt      -> {karaoke_path}")


if __name__ == "__main__":
    main()
