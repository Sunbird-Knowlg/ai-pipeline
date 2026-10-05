import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { TranscriptConfig, TranscriptInput, TranscriptOutput } from './schemas.js';

/** The catalogue view of this unit's contract, registered by `serve()` on boot. */
export const contract: ContractEntry = {
  restateName: 'Transcript',
  // Must be 'run' — the runs API selects a workflow's invocations by this exact handler name
  // (enforced at boot by register.ts's registrationTarget(); getting it wrong doesn't type-error).
  handler: 'run',
  input: TranscriptInput,
  output: TranscriptOutput,
  config: TranscriptConfig,
};
