import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { SummaryConfig, SummaryInput, SummaryOutput } from '@ai-pipeline/contract-summary';

/**
 * The catalogue view of this unit's contract, loaded by `pipeline deploy` from `dist/contract.js`.
 *
 * The schemas themselves live in `@ai-pipeline/contract-summary` rather than here, because
 * `content-enrichment` calls this service and needs them too.
 */
export const contract: ContractEntry = {
  restateName: 'SummaryService',
  handler: 'summarize',
  input: SummaryInput,
  output: SummaryOutput,
  config: SummaryConfig,
};
