import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { RagIngestConfig, RagIngestInput, RagIngestOutput } from './schemas.js';

/**
 * The catalogue view of this unit's contract, registered by `serve()` on boot.
 *
 * core-api starts this workflow for its RAG mutation routes, but by name and through the catalogued
 * schema (Ajv), never by importing these — so the contract stays here, with the unit.
 */
export const contract: ContractEntry = {
  restateName: 'RagIngest',
  handler: 'run',
  input: RagIngestInput,
  output: RagIngestOutput,
  config: RagIngestConfig,
};
