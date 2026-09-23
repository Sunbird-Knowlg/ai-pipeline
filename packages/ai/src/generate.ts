import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { context, propagation } from '@opentelemetry/api';
import { generateText } from 'ai';
import { z } from 'zod';

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
  usage: { inputTokens?: number; outputTokens?: number };
}

/** The one model call workflows and services depend on; providers stay behind it. */
export type Generate = (request: GenerateRequest) => Promise<GenerateResult>;

const envSchema = z.object({
  LITELLM_URL: z.url(),
  LITELLM_API_KEY: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
});

export interface AiOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

/**
 * LiteLLM-backed `Generate`. Retries are disabled here (`maxRetries: 0`) because the caller
 * runs this inside `ctx.run`, where Restate owns retries.
 */
export function createGenerate({ baseUrl, apiKey, timeoutMs = 180_000 }: AiOptions): Generate {
  const provider = createOpenAICompatible({
    name: 'litellm',
    baseURL: `${baseUrl.replace(/\/$/, '')}/v1`,
    apiKey,
    includeUsage: true,
    fetch: tracedFetch,
  });
  return async ({ model, system, prompt, maxOutputTokens, temperature = 0, signal }) => {
    const result = await generateText({
      model: provider.chatModel(model),
      system,
      prompt,
      maxOutputTokens,
      temperature,
      maxRetries: 0,
      abortSignal: signal
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
        : AbortSignal.timeout(timeoutMs),
    });
    return {
      text: result.text,
      model,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    };
  };
}

/** Forwards the active trace context (W3C `traceparent`) so gateway spans join the run's trace. */
const tracedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  });
  return fetch(input, { ...init, headers });
};

export function generateFromEnv(env: NodeJS.ProcessEnv = process.env): Generate {
  const parsed = envSchema.parse(env);
  return createGenerate({
    baseUrl: parsed.LITELLM_URL,
    apiKey: parsed.LITELLM_API_KEY,
    timeoutMs: parsed.LLM_TIMEOUT_MS,
  });
}
