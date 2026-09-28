import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { TranscriptConfig, TranscriptInput, TranscriptOutput } from './schemas.js';

/**
 * The catalogue view of this unit's contract, loaded by `pipeline deploy` from `dist/contract.js`.
 *
 * It lives here rather than in a shared package because nothing else calls this unit yet. Move the
 * schemas into their own `packages/contract-transcript` only when a second unit needs them.
 */
export const contract: ContractEntry = {
  restateName: 'Transcript',
  handler: 'run',
  input: TranscriptInput,
  output: TranscriptOutput,
  config: TranscriptConfig,
};
