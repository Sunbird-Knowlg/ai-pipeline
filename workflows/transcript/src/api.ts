import * as restate from '@restatedev/restate-sdk';
import { TranscriptOutput, TranscriptRequest } from './schemas.js';

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
      "Generates a source-language transcript from a video/audio Content's artifact via Whisper, then translates it into the configured target languages",
  },
);
