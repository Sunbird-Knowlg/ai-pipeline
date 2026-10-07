import { embedMany } from 'ai';
import {
  type AiOptions,
  aiOptionsFromEnv,
  deadline,
  litellmProvider,
  PROVIDER_NAME,
} from './litellm.js';

export interface EmbedRequest {
  /**
   * LiteLLM `model_name` of an embedding model (e.g. `embed-qwen3-0p6b`). Name an immutable alias:
   * vectors from two models are not comparable, so what a collection was embedded with must never
   * change under the same name.
   */
  model: string;
  values: string[];
  /** Values per model call. Small batches keep a local embedding server responsive. */
  batchSize?: number;
  /**
   * Requested output dimensions, for models that support truncating them. Every returned vector
   * must then have exactly this length; a gateway that drops the option fails the call instead of
   * silently writing vectors of another size.
   */
  dimensions?: number;
  /** Aborts the call early, e.g. when the Restate attempt ends (`attemptCompletedSignal`). */
  signal?: AbortSignal;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  dimension: number;
  usage: { tokens: number };
}

/** Embedding model calls, behind the same gateway as `Generate`. */
export type Embed = (request: EmbedRequest) => Promise<EmbedResult>;

/**
 * The model answered, but not with vectors this pipeline can store: the wrong count, a dimension
 * that differs between values or from the one requested, or a non-finite component. Not worth
 * retrying (`isRetryableModelError` says so), because the same request gets the same answer.
 */
export class InvalidEmbeddingError extends Error {
  override name = 'InvalidEmbeddingError';
}

const DEFAULT_BATCH_SIZE = 32;

/**
 * LiteLLM-backed `Embed`. Batches are sent one at a time (`maxParallelCalls: 1`) and never retried
 * here (`maxRetries: 0`): the caller runs this inside `ctx.run`, where Restate owns retries.
 */
export function createEmbed(options: AiOptions): Embed {
  const provider = litellmProvider(options);
  const timeoutMs = options.timeoutMs ?? 180_000;
  return async ({ model, values, batchSize = DEFAULT_BATCH_SIZE, dimensions, signal }) => {
    if (!Number.isInteger(batchSize) || batchSize < 1)
      throw new InvalidEmbeddingError(`batchSize must be a positive integer, not ${batchSize}`);
    const embeddings: number[][] = [];
    let tokens = 0;
    for (let start = 0; start < values.length; start += batchSize) {
      const batch = values.slice(start, start + batchSize);
      const result = await embedMany({
        model: provider.embeddingModel(model),
        values: batch,
        maxRetries: 0,
        maxParallelCalls: 1,
        abortSignal: deadline(timeoutMs, signal),
        ...(dimensions ? { providerOptions: { [PROVIDER_NAME]: { dimensions } } } : {}),
      });
      if (result.embeddings.length !== batch.length)
        throw new InvalidEmbeddingError(
          `${model} returned ${result.embeddings.length} vectors for ${batch.length} values`,
        );
      embeddings.push(...result.embeddings);
      tokens += result.usage.tokens;
    }
    const dimension = dimensions ?? embeddings[0]?.length ?? 0;
    embeddings.forEach((vector, i) => {
      if (vector.length !== dimension)
        throw new InvalidEmbeddingError(
          `${model} returned a ${vector.length}-dimensional vector for value ${i}; expected ${dimension}`,
        );
      if (!vector.every(Number.isFinite))
        throw new InvalidEmbeddingError(`${model} returned a non-finite component for value ${i}`);
    });
    return { embeddings, model, dimension, usage: { tokens } };
  };
}

export function embedFromEnv(env: NodeJS.ProcessEnv = process.env): Embed {
  return createEmbed(aiOptionsFromEnv(env));
}
