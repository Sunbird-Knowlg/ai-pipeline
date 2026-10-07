import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { RagQueryConfig, SearchRequest, SearchResponse } from './schemas.js';

/**
 * The catalogue view of this unit's contract, registered by `serve()` on boot.
 *
 * The catalogue records one handler per unit, so it lists `search`. The service serves five more:
 * `answer`, `listCollections`, `getCollection`, `listDocuments` and `getDocument`, all reached by
 * core-api's RAG routes through the Restate ingress. Their schemas are in `./schemas.ts`, and each
 * handler validates its own input. core-api passes these bodies through without reading them.
 *
 * It lives here rather than in a shared package because no other unit calls this one. Move the
 * schemas into their own `packages/contract-rag-query` only when a second unit needs them.
 */
export const contract: ContractEntry = {
  restateName: 'RagQuery',
  handler: 'search',
  input: SearchRequest,
  output: SearchResponse,
  config: RagQueryConfig,
};
