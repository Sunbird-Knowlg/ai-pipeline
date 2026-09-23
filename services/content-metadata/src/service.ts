import { isRetryableModelError } from '@ai-pipeline/ai/errors';
import type { Generate } from '@ai-pipeline/ai/generate';
import { contentMetadataApi } from '@ai-pipeline/contract-content-metadata/api';
import { serviceOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { CONTENT_METADATA_SYSTEM, metadataPrompt, parseMetadata } from './prompt.js';
import { config, metadata } from './unit.js';

/**
 * One durable LLM step, the same shape as `services/summary`: the model call is the only I/O, it
 * sits inside `ctx.run` with the `llm` retry profile, and `generate` is injected so a test can run
 * the handler against a fake.
 *
 * What differs is the reply. This service asks for JSON, so it has two ways to fail and they are
 * not the same:
 *
 * - the gateway or the model was unavailable — retry, which `retry.llm` does indefinitely, pausing
 *   the run rather than losing it;
 * - the model answered, but not in JSON this service can read — terminal. The call is made at
 *   temperature 0, so the next attempt gets the same reply; retrying would only burn ten attempts
 *   on the way to pausing a run that a human has to look at anyway.
 */
export function createContentMetadataService(generate: Generate) {
  return restate.implement(contentMetadataApi, {
    handlers: {
      extract: async (ctx, { text, maxKeywords }) => {
        // Abandon the model call when this attempt ends (cancel, suspension, retry).
        const signal = ctx.request().attemptCompletedSignal;
        const extracted = await ctx.run(
          'llm.extract-metadata',
          async () => {
            let result;
            try {
              result = await generate({
                model: config.model,
                system: CONTENT_METADATA_SYSTEM,
                prompt: metadataPrompt(text, maxKeywords),
                maxOutputTokens: config.maxOutputTokens,
                signal,
              });
            } catch (error) {
              // A model that refused the request will refuse it again: stop Restate retrying.
              if (isRetryableModelError(error)) throw error;
              throw new restate.TerminalError(
                `model rejected the request: ${(error as Error).message}`,
                { errorCode: 400 },
              );
            }
            const parsed = parseMetadata(result.text);
            if (!parsed)
              throw new restate.TerminalError('the model did not return readable metadata JSON');
            return { ...parsed, model: result.model };
          },
          retry.llm,
        );
        // The model was asked for at most `maxKeywords`; this is what makes that a guarantee.
        return { ...extracted, keywords: extracted.keywords.slice(0, maxKeywords) };
      },
    },
    options: serviceOptions(metadata),
  });
}
