import * as restate from '@restatedev/restate-sdk';
import { filterProblems } from './filter.js';
import type { Hit, RagQueryConfig, RerankWeights, SearchRequest } from './schemas.js';

/**
 * What a search or an answer will do, decided before any I/O. Pure and deterministic, so a handler
 * can run it outside `ctx.run`. It applies the defaults from config, and fails with a 400 that
 * lists every problem the request schema could not express.
 */

/** Mastra's own defaults, made explicit because the weights must arrive as a complete set. */
export const DEFAULT_WEIGHTS: RerankWeights = { semantic: 0.4, vector: 0.4, position: 0.2 };
const WEIGHT_TOLERANCE = 1e-6;
/** Default rerank candidates per hit kept, when the caller does not say. */
const CANDIDATES_PER_HIT = 3;

/** The retrieval part of a search or an answer request. `query` is an answer's `question`. */
export type RetrievalRequest = Pick<
  SearchRequest,
  | 'collection'
  | 'query'
  | 'topK'
  | 'filter'
  | 'minScore'
  | 'includeVector'
  | 'ef'
  | 'probes'
  | 'rerank'
>;

export interface RetrievalPlan {
  collection: string;
  /** Embedded through the collection's query template, and what a reranker scores against. */
  query: string;
  /** Neighbours fetched from the store: the rerank candidates when reranking, else `topK`. */
  fetch: number;
  /** Hits kept. */
  topK: number;
  filter?: Record<string, unknown>;
  minScore?: number;
  includeVector: boolean;
  ef?: number;
  probes?: number;
  rerank?: {
    model: string;
    /** Whether the request named the model, rather than taking config's. */
    requested: boolean;
    weights: RerankWeights;
  };
}

export const invalidRequest = (problems: readonly string[]) =>
  new restate.TerminalError(`invalid request: ${problems.join('; ')}`, { errorCode: 400 });

/**
 * Problems already `found` in the rest of the request (an answer's own fields) are reported
 * together with the retrieval ones, in one 400.
 */
export function planRetrieval(
  request: RetrievalRequest,
  config: RagQueryConfig,
  found: readonly string[] = [],
): RetrievalPlan {
  const { defaults, limits } = config;
  const problems = [...found];
  if (request.filter) problems.push(...filterProblems(request.filter));
  const topK = request.topK ?? defaults.topK;
  if (topK > limits.maxTopK) problems.push(`topK is at most ${limits.maxTopK}`);

  let kept = topK;
  let fetch = topK;
  const rerank = request.rerank;
  if (rerank) {
    kept = rerank.topK ?? topK;
    fetch = rerank.candidates ?? Math.min(limits.maxCandidates, CANDIDATES_PER_HIT * kept);
    if (kept > limits.maxCandidates)
      problems.push(
        `${rerank.topK === undefined ? 'topK' : 'rerank.topK'} is at most ${limits.maxCandidates} when reranking`,
      );
    if (fetch > limits.maxCandidates)
      problems.push(`rerank.candidates is at most ${limits.maxCandidates}`);
    else if (fetch < kept && kept <= limits.maxCandidates)
      problems.push(`rerank.candidates (${fetch}) must be at least the hits kept (${kept})`);
    if (rerank.weights) {
      const { semantic, vector, position } = rerank.weights;
      const sum = semantic + vector + position;
      if (Math.abs(sum - 1) > WEIGHT_TOLERANCE)
        problems.push(`rerank.weights must sum to 1, not ${sum}`);
    }
  }
  if (problems.length > 0) throw invalidRequest(problems);

  return {
    collection: request.collection,
    query: request.query,
    fetch,
    topK: kept,
    ...(request.filter && Object.keys(request.filter).length > 0 ? { filter: request.filter } : {}),
    ...(request.minScore !== undefined ? { minScore: request.minScore } : {}),
    includeVector: request.includeVector ?? false,
    ...(request.ef !== undefined ? { ef: request.ef } : {}),
    ...(request.probes !== undefined ? { probes: request.probes } : {}),
    ...(rerank
      ? {
          rerank: {
            model: rerank.model ?? config.rerankModel,
            requested: rerank.model !== undefined,
            weights: exactWeights(rerank.weights ?? DEFAULT_WEIGHTS),
          },
        }
      : {}),
  };
}

const MILLIONTHS = 1_000_000;
const WEIGHT_KEYS = ['semantic', 'vector', 'position'] as const;

/**
 * Mastra checks the weights' sum in exact decimal arithmetic (big.js): `0.1 + 0.7 + 0.2` passes,
 * but three thirds written as floats do not. So weights that sum to 1 within the tolerance are
 * snapped to millionths that sum to exactly 1 (largest remainder first). That moves none of them by
 * more than a millionth, and `n / 1e6` prints as the exact decimal that big.js reads.
 */
export function exactWeights(weights: RerankWeights): RerankWeights {
  const sum = WEIGHT_KEYS.reduce((total, key) => total + weights[key], 0);
  const raw = WEIGHT_KEYS.map((key) => (weights[key] / sum) * MILLIONTHS);
  const units = raw.map(Math.floor);
  let missing = MILLIONTHS - units.reduce((total, n) => total + n, 0);
  const byRemainder = raw
    .map((value, i) => ({ i, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (missing <= 0) break;
    units[i]! += 1;
    missing -= 1;
  }
  return {
    semantic: units[0]! / MILLIONTHS,
    vector: units[1]! / MILLIONTHS,
    position: units[2]! / MILLIONTHS,
  };
}

/** A rerank result as journaled: just the order and the scores, not the hits again. */
export interface Reranked {
  id: string;
  score: number;
  semantic: number;
  vector: number;
  position: number;
}

/** The retrieved hits in rerank order, each carrying its rerank scores. */
export function applyRerank(hits: readonly Hit[], ranked: readonly Reranked[]): Hit[] {
  const byId = new Map(hits.map((hit) => [hit.id, hit]));
  return ranked.flatMap(({ id, ...scores }) => {
    const hit = byId.get(id);
    return hit ? [{ ...hit, rerank: scores }] : [];
  });
}
