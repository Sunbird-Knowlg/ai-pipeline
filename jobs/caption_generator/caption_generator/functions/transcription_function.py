"""Transcription pipeline (S1-S7): downloads the source media, extracts
audio, runs a transcription provider, uploads captions/transcript JSON, and
updates the Transcript node.
"""

import logging
import os
import shutil
import tempfile
import time

from pyflink.common.typeinfo import Types
from pyflink.datastream.output_tag import OutputTag
from sunbird_ai_core.base.base_process_function import BaseProcessFunction
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaTranscriptionRequest
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient
from sunbird_ai_core.languages import language_name
from sunbird_ai_core.storage.blob_util import BlobStorageUtil

from caption_generator.audio import extract_audio
from caption_generator.builders.vtt_builder import build_transcript_json, build_vtt
from caption_generator.providers.transcription.base import TranscriptionProvider

TRANSCRIPTION_DLQ_TAG = OutputTag("transcription-dlq", Types.STRING())
ENRICHED_METADATA_TAG = OutputTag("enriched-metadata", Types.STRING())


def run_transcription_pipeline(
    request: MediaTranscriptionRequest,
    knowlg: KnowlgClient,
    storage: BlobStorageUtil,
    provider: TranscriptionProvider,
    generated_by: str,
    auto_approve: bool,
    logger: logging.Logger,
) -> str:
    """Runs S1-S7 of the transcription path for one MediaTranscriptionRequest.

    Marks the Transcript node Processing, downloads and transcribes the
    source media, uploads the resulting transcript.json/VTT captions, and
    updates the Transcript node with the result. Raises on any failure —
    the caller is responsible for marking the Transcript node Failed and
    routing to DLQ.

    Args:
        request: The transcription request naming the content/transcript
            and the source media artifact URL.
        knowlg: Knowlg HTTP client for updating the Transcript node.
        storage: Blob storage client for downloading media and uploading
            generated captions/transcript JSON.
        provider: The transcription provider used to transcribe the audio.
        generated_by: Value recorded on the Transcript node's generatedBy
            field (e.g. "faster_whisper:base").
        auto_approve: Whether to mark the Transcript node Live (True) or
            Review (False) on completion.
        logger: Logger for step-by-step progress (start/download/extract/
            transcribe/upload/complete), each tagged with content/transcript id.

    Returns:
        The detected language code, so the caller can emit the
        Transcript-approved event on auto_approve (knowledge-platform's own
        /object/approve API pushes that event; auto-approving via the
        completion PATCH here bypasses that path otherwise, and
        enrichment-router never learns to kick off multilingual generation).

    Raises:
        Exception: Propagates any error from downloading, extracting audio,
            transcribing, uploading, or updating knowlg.
    """
    extra = {"content_id": request.contentId, "transcript_id": request.transcriptId}
    started_at = time.perf_counter()
    logger.info("Transcription started", extra=extra)

    knowlg.patch(  # S1
        "object_update",
        {"objectType": "Transcript", "status": "Processing"},
        identifier=request.contentId,
        objectIdentifier=request.transcriptId,
    )
    logger.info("Marked Transcript Processing", extra=extra)

    tmp_dir = tempfile.mkdtemp(prefix=f"{request.contentId}_transcribe_")
    logger.info("Created temp dir", extra={**extra, "tmp_dir": tmp_dir})
    try:
        video_path = os.path.join(tmp_dir, "source_video")
        logger.info("Downloading source media", extra={**extra, "artifact_url": request.artifactUrl})
        storage.download_from_uri(request.artifactUrl, video_path)  # S2
        logger.info("Downloaded source media", extra=extra)

        audio_path = os.path.join(tmp_dir, "audio.wav")
        logger.info("Extracting audio", extra=extra)
        extract_audio(video_path, audio_path)  # S3
        logger.info("Extracted audio", extra=extra)

        logger.info("Transcribing audio", extra=extra)
        step_started_at = time.perf_counter()
        segments, words, detected_language = provider.transcribe(audio_path)  # S4
        # This function only ever runs for the source-language transcript
        # (languageCode is unset at creation, only known after detection) —
        # use the real detected code, not the empty one read at S1.
        language_code = detected_language
        logger.info(
            "Transcribed audio",
            extra={
                **extra,
                "language_code": language_code,
                "segment_count": len(segments),
                "duration_ms": round((time.perf_counter() - step_started_at) * 1000),
            },
        )

        transcript_json = build_transcript_json(segments)  # S5
        vtt = build_vtt(words)  # one cue per word
        logger.info("Built transcript JSON and VTT", extra={**extra, "language_code": language_code})

        json_key = f"content/{request.contentId}/transcripts/{language_code}/transcript.json"
        vtt_key = f"content/{request.contentId}/transcripts/{language_code}/captions.vtt"
        logger.info("Uploading transcript and captions", extra={**extra, "language_code": language_code})
        storage.upload_bytes(transcript_json.encode("utf-8"), json_key)  # S6
        storage.upload_bytes(vtt.encode("utf-8"), vtt_key)
        logger.info("Uploaded transcript and captions", extra={**extra, "language_code": language_code})

        logger.info("Updating Transcript node", extra={**extra, "language_code": language_code})
        knowlg.patch(  # S7
            "object_update",
            {
                "objectType": "Transcript",
                "code": f"{request.contentId}_{language_code}",
                "languageCode": language_code,
                "language": language_name(language_code),
                "artifactUrl": storage.get_uri(json_key),
                "captionsUrl": storage.get_uri(vtt_key),
                "generatedBy": generated_by,
                "status": "Live" if auto_approve else "Review",
            },
            identifier=request.contentId,
            objectIdentifier=request.transcriptId,
        )
        logger.info(
            "Transcription completed",
            extra={
                **extra,
                "language_code": language_code,
                "duration_ms": round((time.perf_counter() - started_at) * 1000),
            },
        )
        return language_code
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        logger.info("Removed temp dir", extra={**extra, "tmp_dir": tmp_dir})


class TranscriptionFunction(BaseProcessFunction):
    """Flink process function that runs run_transcription_pipeline for each
    transcription-request event and emits a Transcript-approved event on
    auto_approve, or routes failures to the transcription DLQ.
    """

    def __init__(self, config):
        """Stores config; provider/settings are built later in open()."""
        super().__init__(config)
        self._provider = None
        self._generated_by = None
        self._auto_approve = None

    def open(self, runtime_context) -> None:
        """Builds the configured transcription provider in addition to the
        base storage/knowlg clients.

        Args:
            runtime_context: Flink runtime context for the running subtask.
        """
        super().open(runtime_context)
        from caption_generator.providers.factory import build_transcription_provider

        model = self._config.raw("transcription.model")
        self._provider = build_transcription_provider(
            self._config.raw("transcription.provider"),
            model=model,
            device=self._config.raw("transcription.device", "cpu"),
            compute_type=self._config.raw("transcription.compute_type", "int8"),
            language_detection_segments=int(self._config.raw("transcription.language_detection_segments", 8)),
            language_detection_threshold=float(self._config.raw("transcription.language_detection_threshold", 0.7)),
            candidate_languages=self._config.raw("transcription.candidate_languages", []),
        )
        self._generated_by = f"{self._config.raw('transcription.provider')}:{model}"
        self._auto_approve = bool(self._config.raw("transcription.auto_approve", False))

    def process_element(self, value: str, ctx):
        """Transcribes one media-transcription-request event.

        On success, emits an enriched-metadata Transcript-approved event if
        auto_approve is configured. On failure, marks the Transcript node
        Failed and routes the request to the transcription DLQ.

        Args:
            value: The raw JSON string of a MediaTranscriptionRequest event.
            ctx: The PyFlink processing context, passed through to
                emit_to_dlq on failure.

        Yields:
            tuple[OutputTag, str]: An (ENRICHED_METADATA_TAG, event JSON)
            pair on auto-approved success, or (TRANSCRIPTION_DLQ_TAG,
            DLQ envelope JSON) on failure.
        """
        assert self.knowlg is not None, "open() must be called before process_element()"
        assert self.storage is not None, "open() must be called before process_element()"
        assert self.logger is not None, "open() must be called before process_element()"

        request = MediaTranscriptionRequest.from_json(value)
        extra = {"content_id": request.contentId, "transcript_id": request.transcriptId}
        self.logger.info("Received transcription request event", extra=extra)
        try:
            language_code = run_transcription_pipeline(
                request, self.knowlg, self.storage, self._provider, self._generated_by, self._auto_approve, self.logger
            )
            if self._auto_approve:
                self.logger.info("Building Transcript-approved event", extra={**extra, "language_code": language_code})
                event = EnrichedMetadataEvent(
                    id=request.transcriptId,
                    contentType="Transcript",
                    action="approved",
                    data={
                        "contentId": request.contentId,
                        "enrichmentId": request.enrichmentId,
                        "sourceLanguage": True,
                        "languageCode": language_code,
                        "channel": request.channel,
                    },
                )
                self.logger.info("Emitting Transcript-approved event", extra={**extra, "language_code": language_code})
                yield ENRICHED_METADATA_TAG, event.to_json()
            else:
                self.logger.info("Skipping enriched-metadata emit: auto_approve disabled", extra=extra)
        except Exception as error:
            self.logger.exception("Transcription failed", extra=extra)
            self.logger.info("Marking Transcript Failed", extra=extra)
            self.knowlg.patch(
                "object_update",
                {"objectType": "Transcript", "status": "Failed", "errorMessage": str(error)},
                identifier=request.contentId,
                objectIdentifier=request.transcriptId,
            )
            self.logger.info("Routing to transcription DLQ", extra=extra)
            yield from self.emit_to_dlq(request, error, ctx, TRANSCRIPTION_DLQ_TAG)
