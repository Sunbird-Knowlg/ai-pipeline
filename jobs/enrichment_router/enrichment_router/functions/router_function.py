from pyflink.common.typeinfo import Types
from pyflink.datastream.output_tag import OutputTag
from sunbird_ai_core.base.base_process_function import BaseProcessFunction
from sunbird_ai_core.kafka.event_schemas import EnrichedMetadataEvent

from enrichment_router.functions.content_published import handle_content_published
from enrichment_router.functions.transcript_approved import handle_transcript_approved

TRANSCRIPTION_OUT_TAG = OutputTag("transcription-request", Types.STRING())
MULTILINGUAL_OUT_TAG = OutputTag("multilingual-request", Types.STRING())


class RouterFunction(BaseProcessFunction):
    """Reads enriched.metadata, dispatches by contentType, emits job-request
    events to side outputs. Never writes to the graph — read-only, idempotent.
    """

    def process_element(self, value: str, ctx):
        # PyFlink 1.20's ProcessFunction has no ctx.output() — side outputs
        # are emitted by yielding (OutputTag, value) from this generator
        # (confirmed against pyflink.fn_execution.datastream.process.
        # input_handler._emit_results, the only place that consumes what
        # this function yields).
        assert self.logger is not None, "open() must be called before process_element()"
        event = EnrichedMetadataEvent.from_json(value)

        try:
            if event.contentType == "Content":
                yield from self._handle_content_published(event)
            elif event.contentType == "Transcript" and event.action == "approved":
                yield from self._handle_transcript_approved(event)
        except Exception as error:
            self.logger.exception("Failed routing event %s: %s", event.id, error)

    def _handle_content_published(self, event: EnrichedMetadataEvent):
        assert self.graph is not None, "open() must be called before process_element()"
        mime_types = self._config.raw("enrichment.transcript.mime_types", [])
        request = handle_content_published(event, self.graph, mime_types)
        if request is not None:
            yield TRANSCRIPTION_OUT_TAG, request.to_json(env=self._config.env)

    def _handle_transcript_approved(self, event: EnrichedMetadataEvent):
        assert self.graph is not None, "open() must be called before process_element()"
        configured_languages = self._config.raw("enrichment.transcript.languages", [])
        request = handle_transcript_approved(event, self.graph, configured_languages)
        if request is not None:
            yield MULTILINGUAL_OUT_TAG, request.to_json(env=self._config.env)
