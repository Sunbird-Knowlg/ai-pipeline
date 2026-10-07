import type { OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { type AiOptions, aiOptionsFromEnv, litellmProvider } from './litellm.js';

/**
 * An AI SDK language model object for a LiteLLM `model_name`, for libraries that drive the model
 * themselves — Mastra's metadata extractors and relevance scorer — rather than through `Generate`.
 *
 * Those libraries pass no abort signal, so every request is bounded here by the timeout
 * (`LLM_TIMEOUT_MS`): a hung gateway fails the call instead of holding the step. Prefer `Generate`
 * wherever you write the call yourself: it also takes the attempt's signal, and it never retries,
 * where a library given this object may retry on its own.
 */
export type LanguageModel = ReturnType<OpenAICompatibleProvider['chatModel']>;

export type LanguageModels = (model: string) => LanguageModel;

export function createLanguageModels(options: AiOptions): LanguageModels {
  const provider = litellmProvider(options, options.timeoutMs ?? 180_000);
  return (model) => provider.chatModel(model);
}

export function languageModelFromEnv(env: NodeJS.ProcessEnv = process.env): LanguageModels {
  return createLanguageModels(aiOptionsFromEnv(env));
}
