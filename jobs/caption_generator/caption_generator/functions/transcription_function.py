import os
import shutil
import tempfile
from datetime import datetime, timezone

from pyflink.common.typeinfo import Types
from pyflink.datastream.output_tag import OutputTag
from sunbird_ai_core.base.base_process_function import BaseProcessFunction
from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent, MediaTranscriptionRequest
from sunbird_ai_core.languages import language_name
from sunbird_ai_core.storage.blob_util import BlobStorageUtil

from caption_generator.audio import extract_audio
from caption_generator.builders.vtt_builder import build_transcript_json, build_vtt
from caption_generator.providers.transcription.base import TranscriptionProvider
from caption_generator.sync import sync_enrichment_transcripts

TRANSCRIPTION_DLQ_TAG = OutputTag("transcription-dlq", Types.STRING())
ENRICHED_METADATA_TAG = OutputTag("enriched-metadata", Types.STRING())


def run_transcription_pipeline(
    request: MediaTranscriptionRequest,
    graph: JanusGraphUtil,
    storage: BlobStorageUtil,
    provider: TranscriptionProvider,
    generated_by: str,
    auto_approve: bool,
) -> str:
    """S1-S7 of the transcription path. Raises on any failure — caller is
    responsible for marking the Transcript node Failed and routing to DLQ.

    Returns the detected language code, so the caller can emit the
    Transcript-approved event on auto_approve (knowledge-platform's own
    /transcript/approve API pushes that event; auto-approving via a direct
    graph write here bypasses that path entirely otherwise, and
    enrichment-router never learns to kick off multilingual generation).
    """
    transcript_node = graph.get_node(request.transcriptId)
    assert transcript_node is not None, f"Transcript node {request.transcriptId} not found"

    graph.update_node(request.transcriptId, {"status": "Processing"})  # S1

    tmp_dir = tempfile.mkdtemp(prefix=f"{request.contentId}_transcribe_")
    try:
        video_path = os.path.join(tmp_dir, "source_video")
        storage.download_from_uri(request.artifactUrl, video_path)  # S2

        audio_path = os.path.join(tmp_dir, "audio.wav")
        extract_audio(video_path, audio_path)  # S3

        segments, words, detected_language = provider.transcribe(audio_path)  # S4
        # This function only ever runs for the source-language transcript
        # (languageCode is unset at creation, only known after detection) —
        # use the real detected code, not the empty one read at S1.
        language_code = detected_language

        transcript_json = build_transcript_json(segments)  # S5
        vtt = build_vtt(words)  # one cue per word

        json_key = f"content/{request.contentId}/transcripts/{language_code}/transcript.json"
        vtt_key = f"content/{request.contentId}/transcripts/{language_code}/captions.vtt"
        storage.upload_bytes(transcript_json.encode("utf-8"), json_key)  # S6
        storage.upload_bytes(vtt.encode("utf-8"), vtt_key)

        graph.update_node(  # S7
            request.transcriptId,
            {
                "code": f"{request.contentId}_{language_code}",
                "languageCode": language_code,
                "language": language_name(language_code),
                "artifactUrl": storage.get_uri(json_key),
                "captionsUrl": storage.get_uri(vtt_key),
                "generatedBy": generated_by,
                "generatedOn": datetime.now(timezone.utc).isoformat(),
                "status": "Live" if auto_approve else "Review",
                "autoApproved": auto_approve,
                "errorMessage": None,
            },
        )
        sync_enrichment_transcripts(graph, request.enrichmentId)
        return language_code
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


class TranscriptionFunction(BaseProcessFunction):
    def __init__(self, config):
        super().__init__(config)
        self._provider = None
        self._generated_by = None
        self._auto_approve = None

    def open(self, runtime_context) -> None:
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
        assert self.graph is not None, "open() must be called before process_element()"
        assert self.storage is not None, "open() must be called before process_element()"
        assert self.logger is not None, "open() must be called before process_element()"

        request = MediaTranscriptionRequest.from_json(value)
        try:
            language_code = run_transcription_pipeline(
                request, self.graph, self.storage, self._provider, self._generated_by, self._auto_approve
            )
            if self._auto_approve:
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
                yield ENRICHED_METADATA_TAG, event.to_json()
        except Exception as error:
            self.logger.exception("Transcription failed for %s: %s", request.contentId, error)
            self.graph.update_node(
                request.transcriptId, {"status": "Failed", "errorMessage": str(error)}
            )
            yield from self.emit_to_dlq(request, error, ctx, TRANSCRIPTION_DLQ_TAG)
