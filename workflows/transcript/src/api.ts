import * as restate from '@restatedev/restate-sdk';
import { TranscriptInput, TranscriptOutput, TranscriptRequest } from './schemas.js';

/** The Restate binding. The handler must be `run`: the runs API selects invocations by that name. */
export const transcriptApi = restate.iface.workflow(
  'Transcript',
  {
    run: restate.iface.schemas({
      input: TranscriptRequest,
      output: TranscriptOutput,
    }),
  },
  {
    description:
      "Generates a source-language transcript from a video Content's artifact via Whisper, then translates it into the configured target languages",
  },
);

/**
 * The per-Content Virtual Object `transcriptApi.run` delegates to. Keyed by `identifier`, with a
 * single exclusive (non-`shared`) handler, so Restate serializes every call for the same Content —
 * two Kafka deliveries for the same identifier run one after the other, never concurrently.
 */
export const transcriptObjectApi = restate.iface.object(
  'TranscriptObject',
  {
    process: restate.iface.schemas({
      input: TranscriptInput,
      output: TranscriptOutput,
    }),
  },
  {
    description:
      'Serializes Transcript work per-Content so concurrent runs for the same identifier cannot overlap',
  },
);
