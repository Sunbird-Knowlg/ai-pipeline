import type { z } from 'zod';
import { ContentConfig, ContentInput, ContentOutput } from './content-enrichment/schemas.js';
import { SummaryConfig, SummaryInput, SummaryOutput } from './summary/schemas.js';

/**
 * Catalogue view of every shared contract, keyed by metadata `name`. A unit whose contract is
 * not shared may ship its own entry as `export const contract` in `dist/contract.js`. The deploy CLI
 * turns these into JSON Schemas; for a workflow `input` is the canonical input (the core API wraps
 * it in the run request), for a service it is the input of its `handler`.
 *
 * This module imports schema modules only, never a contract's `./api.ts`: the deploy CLI reads the
 * registry, and it has no business loading the Restate SDK to do so.
 */
export interface ContractEntry {
  readonly restateName: string;
  readonly handler: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly config: z.ZodType;
}

export const contracts: Record<string, ContractEntry> = {
  summary: {
    restateName: 'SummaryService',
    handler: 'summarize',
    input: SummaryInput,
    output: SummaryOutput,
    config: SummaryConfig,
  },
  'content-enrichment': {
    restateName: 'ContentEnrichment',
    handler: 'run',
    input: ContentInput,
    output: ContentOutput,
    config: ContentConfig,
  },
};
