import json

from pyflink.common.typeinfo import Types
from pyflink.datastream import ProcessFunction
from pyflink.datastream.output_tag import OutputTag

TRANSCRIPTION_REQUEST_TAG = OutputTag("transcription-request", Types.STRING())
MULTILINGUAL_REQUEST_TAG = OutputTag("multilingual-request", Types.STRING())


class EventRouter(ProcessFunction):
    """Splits the merged transcription+multilingual request stream back into
    two side outputs. Discriminated by shape: only MediaMultilingualRequest
    carries targetLanguages.
    """

    def process_element(self, value: str, ctx):
        # PyFlink 1.20's ProcessFunction has no ctx.output() — side outputs
        # are emitted by yielding (OutputTag, value) from this generator.
        payload = json.loads(value)
        if "targetLanguages" in payload:
            yield MULTILINGUAL_REQUEST_TAG, value
        else:
            yield TRANSCRIPTION_REQUEST_TAG, value
