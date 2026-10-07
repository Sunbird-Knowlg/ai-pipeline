import { type FinishReason, generateText } from 'ai';
import { type AiOptions, aiOptionsFromEnv, deadline, litellmProvider } from './litellm.js';

export interface GenerateRequest {
  /** LiteLLM `model_name` (slash-free, e.g. `chat-default`). */
  model: string;
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Aborts the call early, e.g. when the Restate attempt ends (`attemptCompletedSignal`). */
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  model: string;
  /** Why the model stopped: `length` means it ran into `maxOutputTokens`, mid-answer. */
  finishReason?: FinishReason;
  usage: { inputTokens?: number; outputTokens?: number };
}

/** The one model call workflows and services depend on; providers stay behind it. */
export type Generate = (request: GenerateRequest) => Promise<GenerateResult>;

/**
 * LiteLLM-backed `Generate`. Retries are disabled here (`maxRetries: 0`) because the caller
 * runs this inside `ctx.run`, where Restate owns retries.
 */
export function createGenerate(options: AiOptions): Generate {
  const provider = litellmProvider(options);
  const timeoutMs = options.timeoutMs ?? 180_000;
  return async ({ model, system, prompt, maxOutputTokens, temperature = 0, signal }) => {
    const result = await generateText({
      model: provider.chatModel(model),
      system,
      prompt,
      maxOutputTokens,
      temperature,
      maxRetries: 0,
      abortSignal: deadline(timeoutMs, signal),
    });
    return {
      text: result.text,
      model,
      finishReason: result.finishReason,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  };
}

export function generateFromEnv(env: NodeJS.ProcessEnv = process.env): Generate {
  return createGenerate(aiOptionsFromEnv(env));
}
