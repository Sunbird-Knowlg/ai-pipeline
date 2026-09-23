import * as restate from '@restatedev/restate-sdk';
import { ContentAuthoringOutput, ContentAuthoringRequest } from './schemas.js';

/** The Restate binding. The handler must be `run`: the runs API selects invocations by that name. */
export const contentAuthoringApi = restate.iface.workflow(
  'ContentAuthoring',
  {
    run: restate.iface.schemas({
      input: ContentAuthoringRequest,
      output: ContentAuthoringOutput,
    }),
  },
  { description: 'Builds an authoring pack — summary, metadata and quiz — from DIKSHA content' },
);
