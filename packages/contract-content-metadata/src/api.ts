import * as restate from '@restatedev/restate-sdk';
import { ContentMetadataInput, ContentMetadataOutput } from './schemas.js';

/** The Restate binding for the `content-metadata` contract: what the implementation and its callers share. */
export const contentMetadataApi = restate.iface.service(
  'ContentMetadataService',
  {
    extract: restate.iface.schemas({
      input: ContentMetadataInput,
      output: ContentMetadataOutput,
    }),
  },
  { description: 'Extracts keywords, concepts and a difficulty from a text (private)' },
);
