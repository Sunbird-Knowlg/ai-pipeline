import {
  ContentMetadataConfig,
  ContentMetadataInput,
  ContentMetadataOutput,
} from '@ai-pipeline/contract-content-metadata';
import type { ContractEntry } from '@ai-pipeline/contracts/entry';

/**
 * The catalogue view of this unit's contract, loaded by `pipeline deploy` from `dist/contract.js`.
 *
 * The schemas themselves live in `@ai-pipeline/contract-content-metadata` rather than here, because
 * `content-authoring` calls this service and needs them too.
 */
export const contract: ContractEntry = {
  restateName: 'ContentMetadataService',
  handler: 'extract',
  input: ContentMetadataInput,
  output: ContentMetadataOutput,
  config: ContentMetadataConfig,
};
