import * as restate from '@restatedev/restate-sdk';
import { TranscriptOutput, TranscriptRequest } from './schemas.js';

/** The Restate binding. The handler must be `run`: the runs API selects invocations by that name. */
export const transcriptApi = restate.iface.workflow(
  'Transcript',
  { run: restate.iface.schemas({ input: TranscriptRequest, output: TranscriptOutput }) },
  { description: 'Generates a source transcript and its configured-language translations for a Content item' },
);
