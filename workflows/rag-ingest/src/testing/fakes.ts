import { type Embed, InvalidEmbeddingError } from '@ai-pipeline/ai/embed';
import type { LanguageModels } from '@ai-pipeline/ai/language-model';

/** Test doubles for the model side of the workflow. Not shipped (`src/testing/`). */

export const DIMENSION = 8;

/** A model alias the fake gateway does not know: it refuses the call, as LiteLLM answers a 400. */
export const UNKNOWN_MODEL = 'embed-unknown';

/**
 * A deterministic embedder: each vector counts letters in eight buckets, so texts that share words
 * land near each other. Records every call.
 */
export function fakeEmbed(dimension = DIMENSION) {
  const calls: { model: string; values: string[] }[] = [];
  const embed: Embed = async ({ model, values }) => {
    calls.push({ model, values });
    // Not worth retrying, as `isRetryableModelError` classifies a gateway's 400.
    if (model === UNKNOWN_MODEL) throw new InvalidEmbeddingError(`no such model: ${model}`);
    const embeddings = values.map((value) => {
      const vector = new Array<number>(dimension).fill(0);
      for (const char of value.toLowerCase())
        if (char >= 'a' && char <= 'z') vector[(char.charCodeAt(0) - 97) % dimension]! += 1;
      vector[dimension - 1]! += 1; // never the zero vector
      return vector;
    });
    return { embeddings, model, dimension, usage: { tokens: values.length } };
  };
  return { embed, calls };
}

/** No test reaches a real language model; extraction tests inject `RunExtractors` instead. */
export const noLanguageModels: LanguageModels = () => {
  throw new Error('no language model in this test');
};
