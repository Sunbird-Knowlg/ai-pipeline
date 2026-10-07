import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { context, propagation } from '@opentelemetry/api';
import { z } from 'zod';

/**
 * The LiteLLM gateway every model call goes through. Internal to this package: `./generate`,
 * `./embed` and `./language-model` are the public faces of it, so providers stay behind them.
 */

export const aiEnvSchema = z.object({
  LITELLM_URL: z.url(),
  LITELLM_API_KEY: z.string().min(1),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
});

export interface AiOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export function aiOptionsFromEnv(env: NodeJS.ProcessEnv): AiOptions {
  const parsed = aiEnvSchema.parse(env);
  return {
    baseUrl: parsed.LITELLM_URL,
    apiKey: parsed.LITELLM_API_KEY,
    timeoutMs: parsed.LLM_TIMEOUT_MS,
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

/** The provider is named `litellm`, which is also the key of its `providerOptions`. */
export const PROVIDER_NAME = 'litellm';

/**
 * `requestTimeoutMs` bounds every HTTP request the provider makes, for callers that cannot pass a
 * signal per call (a library driving the model); without it, each call passes its own deadline.
 */
export function litellmProvider(
  { baseUrl, apiKey }: AiOptions,
  requestTimeoutMs?: number,
): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: `${baseUrl.replace(/\/$/, '')}/v1`,
    apiKey,
    includeUsage: true,
    fetch:
      requestTimeoutMs === undefined
        ? tracedFetch
        : (input, init) =>
            tracedFetch(input, {
              ...init,
              signal: deadline(requestTimeoutMs, init?.signal ?? undefined),
            }),
  });
}

/** The caller's signal, bounded by the per-call timeout. */
export const deadline = (timeoutMs: number, signal?: AbortSignal): AbortSignal =>
  signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    : AbortSignal.timeout(timeoutMs);
