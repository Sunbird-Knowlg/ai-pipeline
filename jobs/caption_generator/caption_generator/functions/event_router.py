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
        payload = json.loads(value)
        if "targetLanguages" in payload:
            ctx.output(MULTILINGUAL_REQUEST_TAG, value)
        else:
            ctx.output(TRANSCRIPTION_REQUEST_TAG, value)
