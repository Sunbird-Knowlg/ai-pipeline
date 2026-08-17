import json
import logging

from pyflink.common.typeinfo import Types
from pyflink.datastream import ProcessFunction
from pyflink.datastream.output_tag import OutputTag

logger = logging.getLogger(__name__)

TRANSCRIPTION_REQUEST_TAG = OutputTag("transcription-request", Types.STRING())
MULTILINGUAL_REQUEST_TAG = OutputTag("multilingual-request", Types.STRING())


class EventRouter(ProcessFunction):
    """Splits the merged transcription+multilingual request stream back into
    two side outputs. Discriminated by the BE_JOB_REQUEST envelope's
    edata.action (media-transcription-request vs media-multilingual-request).
    """

    def process_element(self, value: str, ctx):
        """Routes one merged request event to its transcription or multilingual side output.

        PyFlink 1.20's ProcessFunction has no ctx.output() — side outputs
        are emitted by yielding (OutputTag, value) from this generator.

        Args:
            value: The raw JSON string of a BE_JOB_REQUEST envelope.
            ctx: The PyFlink processing context (unused).

        Yields:
            tuple[OutputTag, str]: A (TRANSCRIPTION_REQUEST_TAG or
            MULTILINGUAL_REQUEST_TAG, value) pair.

        Raises:
            json.JSONDecodeError: If value is not valid JSON.
            ValueError: If edata.action is not a recognized request type.
        """
        try:
            payload = json.loads(value)
        except json.JSONDecodeError:
            logger.exception("EventRouter: failed to parse event payload")
            raise
        action = payload.get("edata", {}).get("action", "")
        if action == "media-multilingual-request":
            logger.debug("EventRouter: routing to multilingual", extra={"action": action})
            yield MULTILINGUAL_REQUEST_TAG, value
        elif action == "media-transcription-request":
            logger.debug("EventRouter: routing to transcription", extra={"action": action})
            yield TRANSCRIPTION_REQUEST_TAG, value
        else:
            logger.error("EventRouter: unrecognized edata.action", extra={"action": action})
            raise ValueError(f"EventRouter: unrecognized edata.action: {action!r}")
