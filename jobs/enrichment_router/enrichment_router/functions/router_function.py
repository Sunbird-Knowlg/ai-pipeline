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
        """Routes one enriched.metadata event to the appropriate side output.

        Content-published events are dispatched to transcription; approved
        source-language Transcript events are dispatched to multilingual.
        Any other combination is silently ignored. Errors are caught and
        logged rather than propagated, since PyFlink 1.20's ProcessFunction
        has no ctx.output() — side outputs are emitted by yielding
        (OutputTag, value) from this generator.

        Args:
            value: The raw JSON string of the enriched.metadata event.
            ctx: The PyFlink processing context (unused).

        Yields:
            tuple[OutputTag, str]: A (TRANSCRIPTION_OUT_TAG or
            MULTILINGUAL_OUT_TAG, JSON payload) pair for the routed request.
            Any failure, including a malformed value that fails
            EnrichedMetadataEvent.from_json, is caught and logged rather
            than propagated — an uncaught exception would otherwise never
            commit the triggering Kafka offset, crash-looping the job on
            the same malformed message forever.
        """
        assert self.logger is not None, "open() must be called before process_element()"
        try:
            event = EnrichedMetadataEvent.from_json(value)
            extra = {"event_id": event.id, "content_type": event.contentType, "action": event.action}
            self.logger.info("Routing event", extra=extra)

            routed = False
            if event.contentType == "Content" and event.action == "publish":
                for out in self._handle_content_published(event):
                    routed = True
                    yield out
            elif event.contentType == "Transcript" and event.action == "approved":
                for out in self._handle_transcript_approved(event):
                    routed = True
                    yield out
            self.logger.info("Routed event" if routed else "Ignored event", extra={**extra, "routed": routed})
        except Exception:
            self.logger.exception("Failed routing event")

    def _handle_content_published(self, event: EnrichedMetadataEvent):
        """Dispatches a content-published event to transcription, if eligible.

        Args:
            event: The content-published enriched.metadata event.

        Yields:
            tuple[OutputTag, str]: (TRANSCRIPTION_OUT_TAG, JSON payload) if
            the content is eligible for transcription; nothing otherwise.
        """
        assert self.knowlg is not None, "open() must be called before process_element()"
        mime_types = self._config.raw("enrichment.transcript.mime_types", [])
        request = handle_content_published(event, self.knowlg, mime_types)
        if request is not None:
            yield TRANSCRIPTION_OUT_TAG, request.to_json(env=self._config.env)

    def _handle_transcript_approved(self, event: EnrichedMetadataEvent):
        """Dispatches an approved source-language transcript to multilingual.

        Args:
            event: The transcript-approved enriched.metadata event.

        Yields:
            tuple[OutputTag, str]: (MULTILINGUAL_OUT_TAG, JSON payload) if
            any target languages still need translation; nothing otherwise.
        """
        assert self.knowlg is not None, "open() must be called before process_element()"
        configured_languages = self._config.raw("enrichment.transcript.languages", [])
        request = handle_transcript_approved(event, self.knowlg, configured_languages)
        if request is not None:
            yield MULTILINGUAL_OUT_TAG, request.to_json(env=self._config.env)
