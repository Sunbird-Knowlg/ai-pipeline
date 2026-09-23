import * as restate from '@restatedev/restate-sdk';
import { ContentEnrichmentRequest, ContentOutput } from './schemas.js';

/** The Restate binding for the `content-enrichment` contract. */
export const contentEnrichmentApi = restate.iface.workflow(
  'ContentEnrichment',
  { run: restate.iface.schemas({ input: ContentEnrichmentRequest, output: ContentOutput }) },
  { description: 'Summarises published content and attaches metadata' },
);
