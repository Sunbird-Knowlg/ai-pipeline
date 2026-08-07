"""Multilingual translation pipeline (M1-M4): resolves target-language
Transcript nodes, downloads the source transcript, translates it per
target language in parallel, and updates each Transcript node.
"""

import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

from pyflink.common.typeinfo import Types
from pyflink.datastream.output_tag import OutputTag
from sunbird_ai_core.base.base_process_function import BaseProcessFunction
from sunbird_ai_core.kafka.event_schemas import MediaMultilingualRequest
from sunbird_ai_core.knowlg.knowlg_client import KnowlgClient
from sunbird_ai_core.storage.blob_util import BlobStorageUtil

from caption_generator.builders.vtt_builder import build_transcript_json, build_vtt, parse_transcript_json
from caption_generator.chunking import chunk_segments, merge_translated_batches
from caption_generator.providers.multilingual.base import MultilingualProvider
from caption_generator.segment import Segment

MULTILINGUAL_DLQ_TAG = OutputTag("multilingual-dlq", Types.STRING())


def resolve_target_transcript_ids(
    knowlg: KnowlgClient, content_id: str, target_languages: list[str]
) -> dict[str, str]:
    """Maps each requested target language to its existing Transcript node id.

    Args:
        knowlg: Knowlg HTTP client for reading Enrichment state.
        content_id: The content identifier (enrichment/read is keyed by the
            *content* id, not the Enrichment node's own id).
        target_languages: The languages to resolve Transcript node ids for.

    Returns:
        A dict of language code to Transcript node identifier, containing
        only languages from target_languages that already have a
        non-source-language Transcript node.
    """
    response = knowlg.get("enrichment_read", identifier=content_id)
    enrichment = response.get("result", {}).get("enrichment", {})
    transcripts = enrichment.get("transcripts", [])
    by_language = {t["languageCode"]: t["identifier"] for t in transcripts if not t.get("sourceLanguage")}
    return {lang: by_language[lang] for lang in target_languages if lang in by_language}


def translate_one_language(
    content_id: str,
    transcript_id: str,
    source_segments: list[Segment],
    source_lang: str,
    target_lang: str,
    knowlg: KnowlgClient,
    storage: BlobStorageUtil,
    provider: MultilingualProvider,
    batch_size: int,
    overlap: int,
    auto_approve: bool,
) -> None:
    """Runs M3-M4 (chunk, translate, upload) for a single target language.

    On failure, marks this language's Transcript node Failed and re-raises —
    other languages are unaffected.

    Args:
        content_id: The content identifier.
        transcript_id: The target-language Transcript node identifier.
        source_segments: The source-language segments to translate.
        source_lang: The source language code.
        target_lang: The target language code.
        knowlg: Knowlg HTTP client for updating the Transcript node.
        storage: Blob storage client for uploading generated captions/JSON.
        provider: The multilingual provider used to translate segments.
        batch_size: Maximum segments per translation batch.
        overlap: Trailing segments repeated across batch boundaries.
        auto_approve: Whether to mark the Transcript node Live (True) or
            Review (False) on completion.

    Raises:
        Exception: Propagates any error from translation, upload, or the
            knowlg update, after marking the Transcript node Failed.
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

        knowlg.patch(
            "object_update",
            {
                "objectType": "Transcript",
                "artifactUrl": storage.get_uri(json_key),
                "captionsUrl": storage.get_uri(vtt_key),
                "generatedBy": "litellm",
                "status": "Live" if auto_approve else "Review",
            },
            identifier=content_id,
            objectIdentifier=transcript_id,
        )
    except Exception as error:
        knowlg.patch(
            "object_update",
            {"objectType": "Transcript", "status": "Failed", "errorMessage": str(error)},
            identifier=content_id,
            objectIdentifier=transcript_id,
        )
        raise


class MultilingualFunction(BaseProcessFunction):
    """Flink process function that translates one source transcript into all
    configured target languages in parallel, per media-multilingual-request
    event, routing per-language or whole-request failures to the DLQ.
    """

    def __init__(self, config):
        """Stores config; provider/settings are built later in open()."""
        super().__init__(config)
        self._provider = None
        self._batch_size = None
        self._overlap = None
        self._auto_approve = None

    def open(self, runtime_context) -> None:
        """Builds the configured multilingual provider and batching settings
        in addition to the base storage/knowlg clients.

        Args:
            runtime_context: Flink runtime context for the running subtask.
        """
        super().open(runtime_context)
        from caption_generator.providers.factory import build_multilingual_provider

        self._provider = build_multilingual_provider(
            self._config.raw("multilingual.provider"),
            model=self._config.raw("multilingual.model"),
            api_key=self._config.raw("multilingual.api_key"),
            api_base=self._config.raw("multilingual.api_base", ""),
            api_version=self._config.raw("multilingual.api_version", ""),
        )
        self._batch_size = int(self._config.raw("multilingual.batch_size", 80))
        self._overlap = int(self._config.raw("multilingual.context_overlap", 2))
        self._auto_approve = bool(self._config.raw("multilingual.auto_approve", True))

    def process_element(self, value: str, ctx):
        """Translates one source transcript into all requested target languages.

        Resolves target Transcript node ids and downloads the source
        transcript (M1-M2), then translates and uploads each target
        language concurrently (M3-M4). A failure resolving/downloading fails
        the whole request; a failure translating one language only affects
        that language.

        Args:
            value: The raw JSON string of a MediaMultilingualRequest event.
            ctx: The PyFlink processing context, passed through to
                emit_to_dlq on failure.

        Yields:
            tuple[OutputTag, str]: (MULTILINGUAL_DLQ_TAG, DLQ envelope JSON)
            for the whole request or for any individual target language that
            fails to translate.
        """
        assert self.knowlg is not None, "open() must be called before process_element()"
        assert self.storage is not None, "open() must be called before process_element()"
        assert self.logger is not None, "open() must be called before process_element()"

        request = MediaMultilingualRequest.from_json(value)
        transcript_ids: dict[str, str] = {}

        try:
            # M1
            transcript_ids = resolve_target_transcript_ids(
                self.knowlg, request.contentId, request.targetLanguages
            )
            for transcript_id in transcript_ids.values():
                self.knowlg.patch(
                    "object_update",
                    {"objectType": "Transcript", "status": "Processing"},
                    identifier=request.contentId,
                    objectIdentifier=transcript_id,
                )

            # M2
            tmp_path = tempfile.mktemp(suffix=".json")
            self.storage.download_from_uri(request.sourceTranscriptUrl, tmp_path)
            with open(tmp_path, "r") as f:
                source_segments = parse_transcript_json(f.read())
        except Exception as error:
            # An uncaught exception here fails the whole Flink job and the
            # poisoned message crash-loops it forever; route to DLQ instead.
            self.logger.exception("Multilingual M1/M2 failed for %s: %s", request.contentId, error)
            for transcript_id in transcript_ids.values():
                self.knowlg.patch(
                    "object_update",
                    {"objectType": "Transcript", "status": "Failed", "errorMessage": str(error)},
                    identifier=request.contentId,
                    objectIdentifier=transcript_id,
                )
            yield from self.emit_to_dlq(request, error, ctx, MULTILINGUAL_DLQ_TAG)
            return

        # KnowlgClient issues one stateless HTTP request per call (via
        # `requests`), so sharing it across worker threads here needs no
        # per-thread connection handling, unlike the JanusGraph websocket
        # this used to share.
        with ThreadPoolExecutor(max_workers=len(transcript_ids) or 1) as executor:
            futures = {
                executor.submit(
                    translate_one_language,
                    request.contentId,
                    transcript_id,
                    source_segments,
                    request.sourceLanguage,
                    target_lang,
                    self.knowlg,
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
                    yield from self.emit_to_dlq(request, error, ctx, MULTILINGUAL_DLQ_TAG)

        # Enrichment.transcripts re-sync and ECAR rebuild are now handled
        # server-side by knowlg's object/update itself whenever a Transcript
        # transitions to Live/Review (TranscriptManager.syncAndMaybeBuildEcar)
        # — no client-side M5 step needed anymore.
