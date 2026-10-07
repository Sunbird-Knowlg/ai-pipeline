import * as restate from '@restatedev/restate-sdk';
import { RagIngestOutput, RagIngestRequest } from './schemas.js';

/** The Restate binding. The handler must be `run`: the runs API selects invocations by that name. */
export const ragIngestApi = restate.iface.workflow(
  'RagIngest',
  { run: restate.iface.schemas({ input: RagIngestRequest, output: RagIngestOutput }) },
  {
    description:
      'Indexes documents into a RAG collection with Mastra (chunk, extract, embed, PgVector), deletes them, or drops the collection',
  },
);
