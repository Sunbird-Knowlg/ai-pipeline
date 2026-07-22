import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from pyflink.common.typeinfo import Types
from pyflink.datastream.output_tag import OutputTag
from sunbird_ai_core.base.base_process_function import BaseProcessFunction
from sunbird_ai_core.graph.janusgraph_util import JanusGraphUtil
from sunbird_ai_core.kafka.event_schemas import MediaMultilingualRequest
from sunbird_ai_core.storage.blob_util import BlobStorageUtil

from caption_generator.builders.ecar_builder import build_and_upload_ecar
from caption_generator.builders.vtt_builder import build_transcript_json, build_vtt, parse_transcript_json
from caption_generator.chunking import chunk_segments, merge_translated_batches
from caption_generator.providers.multilingual.base import MultilingualProvider
from caption_generator.segment import Segment
from caption_generator.sync import is_ecar_ready, sync_enrichment_transcripts

MULTILINGUAL_DLQ_TAG = OutputTag("multilingual-dlq", Types.STRING())


def resolve_target_transcript_ids(
    graph: JanusGraphUtil, enrichment_id: str, target_languages: list[str]
) -> dict[str, str]:
    transcripts = graph.get_related_nodes(enrichment_id, "transcripts", direction="out")
    by_language = {t["languageCode"]: t["IL_UNIQUE_ID"] for t in transcripts if not t.get("sourceLanguage")}
    return {lang: by_language[lang] for lang in target_languages if lang in by_language}


def translate_one_language(
    content_id: str,
    transcript_id: str,
    source_segments: list[Segment],
    source_lang: str,
    target_lang: str,
    graph: JanusGraphUtil,
    storage: BlobStorageUtil,
    provider: MultilingualProvider,
    batch_size: int,
    overlap: int,
    auto_approve: bool,
) -> None:
    """M3-M4 for a single target language. On failure, marks this language's
    Transcript node Failed and re-raises — other languages are unaffected.
    """
    try:
        batches = chunk_segments(source_segments, batch_size, overlap)  # M3
        translated_batches = [
            provider.translate(batch, source_lang, target_lang) for batch in batches  # M4
        ]
        merged = merge_translated_batches(translated_batches)

        transcript_json = build_transcript_json(merged)
        vtt = build_vtt(merged)

        json_key = f"content/{content_id}/transcripts/{target_lang}/transcript.json"
        vtt_key = f"content/{content_id}/transcripts/{target_lang}/captions.vtt"
        storage.upload_bytes(transcript_json.encode("utf-8"), json_key)
        storage.upload_bytes(vtt.encode("utf-8"), vtt_key)

        graph.update_node(
            transcript_id,
            {
                "artifactUrl": storage.get_uri(json_key),
                "captionsUrl": storage.get_uri(vtt_key),
                "generatedBy": "litellm",
                "generatedOn": datetime.now(timezone.utc).isoformat(),
                "status": "Live" if auto_approve else "Review",
                "autoApproved": auto_approve,
            },
        )
    except Exception as error:
        graph.update_node(transcript_id, {"status": "Failed", "errorMessage": str(error)})
        raise


class MultilingualFunction(BaseProcessFunction):
    def __init__(self, config):
        super().__init__(config)
        self._provider = None
        self._batch_size = None
        self._overlap = None
        self._auto_approve = None
        self._allow_failed_languages = None

    def open(self, runtime_context) -> None:
        super().open(runtime_context)
        from caption_generator.providers.factory import build_multilingual_provider

        self._provider = build_multilingual_provider(
            self._config.raw("multilingual.provider"),
            model=self._config.raw("multilingual.model"),
            api_key=self._config.raw("multilingual.api_key"),
        )
        self._batch_size = int(self._config.raw("multilingual.batch_size", 80))
        self._overlap = int(self._config.raw("multilingual.context_overlap", 2))
        self._auto_approve = bool(self._config.raw("multilingual.auto_approve", True))
        self._allow_failed_languages = bool(
            self._config.raw("multilingual.ecar.allow_failed_languages", True)
        )

    def process_element(self, value: str, ctx):
        assert self.graph is not None, "open() must be called before process_element()"
        assert self.storage is not None, "open() must be called before process_element()"
        assert self.logger is not None, "open() must be called before process_element()"

        request = MediaMultilingualRequest.from_json(value)

        # M1
        transcript_ids = resolve_target_transcript_ids(
            self.graph, request.enrichmentId, request.targetLanguages
        )
        for transcript_id in transcript_ids.values():
            self.graph.update_node(transcript_id, {"status": "Processing"})

        # M2
        tmp_path = tempfile.mktemp(suffix=".json")
        self.storage.download_from_uri(request.sourceTranscriptUrl, tmp_path)
        with open(tmp_path, "r") as f:
            source_segments = parse_transcript_json(f.read())

        # ponytail: shares one JanusGraphUtil connection across worker threads —
        # revisit with per-thread connections if gremlinpython isn't thread-safe under load.
        with ThreadPoolExecutor(max_workers=len(transcript_ids) or 1) as executor:
            futures = {
                executor.submit(
                    translate_one_language,
                    request.contentId,
                    transcript_id,
                    source_segments,
                    request.sourceLanguage,
                    target_lang,
                    self.graph,
                    self.storage,
                    self._provider,
                    self._batch_size,
                    self._overlap,
                    self._auto_approve,
                ): target_lang
                for target_lang, transcript_id in transcript_ids.items()
            }
            for future in as_completed(futures):
                target_lang = futures[future]
                try:
                    future.result()
                except Exception as error:
                    self.logger.exception(
                        "Multilingual translation failed for %s/%s", request.contentId, target_lang
                    )
                    self.emit_to_dlq(request, error, ctx, MULTILINGUAL_DLQ_TAG)

        # M5
        transcripts = sync_enrichment_transcripts(self.graph, request.enrichmentId)
        if is_ecar_ready(transcripts, self._allow_failed_languages):
            enrichment = self.graph.get_node(request.enrichmentId)
            assert enrichment is not None, f"Enrichment node {request.enrichmentId} not found"
            ecar_url = build_and_upload_ecar(request.contentId, enrichment, transcripts, self.storage)
            self.graph.update_node(request.enrichmentId, {"transcriptUrl": ecar_url})
