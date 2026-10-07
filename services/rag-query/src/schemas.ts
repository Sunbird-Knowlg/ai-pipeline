import {
  CollectionName,
  CollectionSettings,
  DocumentId,
  DocumentMetadata,
  Format,
} from '@ai-pipeline/rag/schemas';
import { z } from 'zod';

/**
 * The `rag-query` contract's data shapes: a request and a response for each of the six handlers.
 * Kept apart from `./api.ts` so the catalogue side of the contract needs no Restate SDK.
 *
 * There is no `.refine()` here, because the catalogue publishes these as JSON Schema, which cannot
 * carry one. The handler checks the rules that span fields (rerank weights that sum to 1, this
 * deployment's limits, the allowed filter operators) and fails with a 400. Defaults that come from
 * config are applied there too, so every optional field stays optional for a typed caller.
 */

export const QUERY_MAX = 4_000;
export const TOP_K_MAX = 50;
/** Reranking makes one model call per candidate, so there are few candidates. */
export const CANDIDATES_MAX = 20;
export const DOCUMENTS_PAGE_MAX = 200;
export const DOCUMENTS_PAGE_DEFAULT = 50;

/**
 * A Mastra metadata filter over chunk metadata, MongoDB-style: `{ lang: 'en', year: { $gte: 2020 } }`.
 * The handler checks its operators (`./filter.ts`).
 */
export const MetadataFilter = z.record(z.string(), z.unknown());
export type MetadataFilter = z.infer<typeof MetadataFilter>;

const Weight = z.number().min(0).max(1);

export const RerankWeights = z.strictObject({ semantic: Weight, vector: Weight, position: Weight });
export type RerankWeights = z.infer<typeof RerankWeights>;

export const RerankOptions = z.strictObject({
  /** LiteLLM `model_name` that scores each candidate's relevance. Default: config `rerankModel`. */
  model: z.string().min(1).max(200).optional(),
  /** Nearest neighbours fetched and scored. Default: three times the hits kept, up to the limit. */
  candidates: z.number().int().min(1).max(CANDIDATES_MAX).optional(),
  /** Hits kept after reranking. Default: `topK`. */
  topK: z.number().int().min(1).max(CANDIDATES_MAX).optional(),
  /**
   * The rerank score mixes the model's relevance score (`semantic`), the vector score (`vector`) and
   * the original rank (`position`). The three weights must sum to 1. Default: 0.4 / 0.4 / 0.2.
   */
  weights: RerankWeights.optional(),
});
export type RerankOptions = z.infer<typeof RerankOptions>;

/** The retrieval fields that a search and an answer share. */
const retrieval = {
  /** Hits returned by a search, or offered as evidence to an answer. Default: config `defaults.topK`. */
  topK: z.number().int().min(1).max(TOP_K_MAX).optional(),
  filter: MetadataFilter.optional(),
  /**
   * Drops hits whose vector score is below this value. It is applied after the query, because
   * passing it to the store would turn off the HNSW index.
   */
  minScore: z.number().optional(),
  /** HNSW `ef_search` for this query: higher is more exact, and slower. */
  ef: z.number().int().min(1).max(1000).optional(),
  /** IVFFlat probes. Accepted, but has no effect: collections use HNSW or a flat scan. */
  probes: z.number().int().min(1).max(1000).optional(),
  rerank: RerankOptions.optional(),
};

export const SearchRequest = z.strictObject({
  collection: CollectionName,
  query: z.string().min(1).max(QUERY_MAX),
  ...retrieval,
  /** Also return each hit's embedding. */
  includeVector: z.boolean().optional(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

/** One retrieved chunk. */
export const Hit = z.strictObject({
  /** The chunk's id. */
  id: z.string(),
  /** Vector similarity to the query (higher is closer). It means the same with or without a rerank. */
  score: z.number(),
  documentId: z.string(),
  chunkIndex: z.number().int(),
  title: z.string().optional(),
  text: z.string(),
  /**
   * The chunk's metadata: the document's metadata plus anything chunking or extraction added. The
   * keys the pipeline writes itself (`text`, `documentId`, `chunkIndex`, …) are left out.
   */
  metadata: z.record(z.string(), z.unknown()),
  vector: z.array(z.number()).optional(),
  /** Set when the hits were reranked. The hits are then in `rerank.score` order. */
  rerank: z
    .strictObject({
      score: z.number(),
      semantic: z.number(),
      vector: z.number(),
      position: z.number(),
    })
    .optional(),
});
export type Hit = z.infer<typeof Hit>;

export const SearchResponse = z.strictObject({
  collection: z.string(),
  /** The model the collection, and so this query, was embedded with. */
  embeddingModel: z.string(),
  hits: z.array(Hit),
  /** The hits went through the rerank step (there were candidates, and a rerank was asked for). */
  reranked: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const AnswerRequest = z.strictObject({
  collection: CollectionName,
  question: z.string().min(1).max(QUERY_MAX),
  ...retrieval,
  /** LiteLLM `model_name` that writes the answer. Default: config `answerModel`. */
  model: z.string().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Default: 1024, or config `limits.maxOutputTokens` if lower; at most that limit. */
  maxOutputTokens: z.number().int().min(64).max(4096).optional(),
  /**
   * Characters of prompt the model reads: the question, the instructions and the evidence, which
   * gets what the other two leave. Default, and upper bound: config `limits.maxContextChars`.
   */
  maxContextChars: z.number().int().min(500).max(50_000).optional(),
  /** Extra guidance appended to the system prompt (tone, length, language). */
  instructions: z.string().max(2000).optional(),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;

export const Citation = z.strictObject({
  /** The source marker the answer uses, e.g. `S1`. */
  id: z.string(),
  documentId: z.string(),
  chunkIndex: z.number().int(),
  title: z.string().optional(),
  /** The cited chunk's vector score. */
  score: z.number(),
});
export type Citation = z.infer<typeof Citation>;

export const AnswerResponse = z.strictObject({
  collection: z.string(),
  /** `insufficient_evidence` when nothing relevant was found, or the model could not ground an answer. */
  status: z.enum(['answered', 'insufficient_evidence']),
  /** The answer text, with `[S#]` markers that each name a citation. */
  answer: z.string(),
  citations: z.array(Citation),
  model: z.string(),
  /** Set when the model ran out of `maxOutputTokens`: the answer stops mid-way. */
  truncated: z.literal(true).optional(),
});
export type AnswerResponse = z.infer<typeof AnswerResponse>;

/** Takes no parameters; send `{}`. */
export const ListCollectionsRequest = z.strictObject({});
export type ListCollectionsRequest = z.infer<typeof ListCollectionsRequest>;

export const CollectionView = z.strictObject({
  name: z.string(),
  embeddingModel: z.string(),
  dimension: z.number().int(),
  settings: CollectionSettings,
  documents: z.number().int(),
  chunks: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CollectionView = z.infer<typeof CollectionView>;

export const CollectionsResponse = z.strictObject({ collections: z.array(CollectionView) });
export type CollectionsResponse = z.infer<typeof CollectionsResponse>;

export const GetCollectionRequest = z.strictObject({ collection: CollectionName });
export type GetCollectionRequest = z.infer<typeof GetCollectionRequest>;

export const ListDocumentsRequest = z.strictObject({
  collection: CollectionName,
  /** Documents per page. Default: 50. */
  limit: z.number().int().min(1).max(DOCUMENTS_PAGE_MAX).optional(),
  /**
   * The `nextCursor` of the previous page. A cursor encodes a document id (up to 512 characters, so
   * up to 1,536 bytes of UTF-8) in base64url: 2,048 characters at most.
   */
  cursor: z.string().max(2048).optional(),
});
export type ListDocumentsRequest = z.infer<typeof ListDocumentsRequest>;

export const DocumentView = z.strictObject({
  documentId: z.string(),
  title: z.string().optional(),
  format: Format.optional(),
  metadata: DocumentMetadata,
  chunkCount: z.number().int(),
  fingerprint: z.string(),
  /** The write order this version won with: the producer's `version`, else when it was received. */
  seq: z.number(),
  /** The ingest run that wrote this version. */
  runId: z.string(),
  updatedAt: z.string(),
});
export type DocumentView = z.infer<typeof DocumentView>;

export const DocumentsResponse = z.strictObject({
  documents: z.array(DocumentView),
  nextCursor: z.string().optional(),
});
export type DocumentsResponse = z.infer<typeof DocumentsResponse>;

export const GetDocumentRequest = z.strictObject({
  collection: CollectionName,
  documentId: DocumentId,
  /** Also return the document's chunks, in order. */
  chunks: z.boolean().optional(),
});
export type GetDocumentRequest = z.infer<typeof GetDocumentRequest>;

export const Chunk = z.strictObject({
  id: z.string(),
  chunkIndex: z.number().int(),
  text: z.string(),
  /** As in `Hit.metadata`: without the keys the pipeline writes itself. */
  metadata: z.record(z.string(), z.unknown()),
});
export type Chunk = z.infer<typeof Chunk>;

export const DocumentResponse = DocumentView.extend({ chunks: z.array(Chunk).optional() });
export type DocumentResponse = z.infer<typeof DocumentResponse>;

/**
 * Settings read from `metadata.json`. `limits` caps what a request may ask for (a larger value is a
 * 400, not silently lowered); the request schemas above are the hard ceiling for any deployment.
 */
export const RagQueryConfig = z.strictObject({
  answerModel: z.string().min(1).max(200),
  rerankModel: z.string().min(1).max(200),
  defaults: z.strictObject({
    topK: z.number().int().min(1).max(TOP_K_MAX),
  }),
  limits: z.strictObject({
    maxTopK: z.number().int().min(1).max(TOP_K_MAX),
    maxCandidates: z.number().int().min(1).max(CANDIDATES_MAX),
    /**
     * Characters of question, instructions and evidence. With `maxOutputTokens`, sized so that the
     * prompt and the answer fit the answer model's context (8,192 tokens for `chat-default`); text in
     * scripts that need more tokens per character needs a smaller value.
     */
    maxContextChars: z.number().int().min(500).max(50_000),
    /** The longest answer a request may ask for, in tokens. */
    maxOutputTokens: z.number().int().min(64).max(4096),
  }),
});
export type RagQueryConfig = z.infer<typeof RagQueryConfig>;

/** The config rules JSON Schema cannot state; checked at boot. Empty when the config is usable. */
export function configProblems(config: RagQueryConfig): string[] {
  const { defaults, limits } = config;
  const problems: string[] = [];
  if (defaults.topK > limits.maxTopK)
    problems.push(`defaults.topK (${defaults.topK}) exceeds limits.maxTopK (${limits.maxTopK})`);
  // A rerank keeps `topK` hits unless told otherwise, so a bare `rerank: {}` would be refused.
  if (defaults.topK > limits.maxCandidates)
    problems.push(
      `defaults.topK (${defaults.topK}) exceeds limits.maxCandidates (${limits.maxCandidates})`,
    );
  return problems;
}
