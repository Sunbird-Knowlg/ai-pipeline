import * as restate from '@restatedev/restate-sdk';
import { SummaryInput, SummaryOutput } from './schemas.js';

/** The Restate binding for the `summary` contract: what implementations and callers share. */
export const summaryApi = restate.iface.service(
  'SummaryService',
  { summarize: restate.iface.schemas({ input: SummaryInput, output: SummaryOutput }) },
  { description: 'Summarises text with an LLM (private; called by workflows)' },
);
