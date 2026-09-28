import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { TranscriptConfig, TranscriptInput, TranscriptOutput } from './schemas.js';

/** The catalogue view of this unit's contract, registered by `serve()` on boot. */
export const contract: ContractEntry = {
  restateName: 'Transcript',
  handler: 'run',
  input: TranscriptInput,
  output: TranscriptOutput,
  config: TranscriptConfig,
};
