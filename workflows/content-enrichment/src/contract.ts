import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { ContentConfig, ContentInput, ContentOutput } from './schemas.js';

/**
 * The catalogue view of this unit's contract, loaded by `pipeline deploy` from `dist/contract.js`.
 *
 * It lives in the unit because nothing else calls this workflow. A contract only moves into a
 * package of its own when a *second* unit needs it — as `@ai-pipeline/contract-summary` does,
 * because this workflow calls the summary service. Keeping it here is what lets a new workflow be
 * added without changing any existing unit's artifact.
 */
export const contract: ContractEntry = {
  restateName: 'ContentEnrichment',
  handler: 'run',
  input: ContentInput,
  output: ContentOutput,
  config: ContentConfig,
};
