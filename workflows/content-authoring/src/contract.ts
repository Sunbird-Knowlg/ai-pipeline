import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import {
  ContentAuthoringConfig,
  ContentAuthoringInput,
  ContentAuthoringOutput,
} from './schemas.js';

/**
 * The catalogue view of this unit's contract, loaded by `pipeline deploy` from `dist/contract.js`.
 *
 * It lives in the unit because nothing else calls this workflow. A contract only moves into a
 * package of its own when a *second* unit needs it — as `@ai-pipeline/contract-quiz-generate` and
 * `@ai-pipeline/contract-content-metadata` did, because this workflow calls those services.
 * Keeping this one here is what lets the next workflow be added without changing this unit's
 * artifact, and therefore without forcing a version bump.
 */
export const contract: ContractEntry = {
  restateName: 'ContentAuthoring',
  handler: 'run',
  input: ContentAuthoringInput,
  output: ContentAuthoringOutput,
  config: ContentAuthoringConfig,
};
