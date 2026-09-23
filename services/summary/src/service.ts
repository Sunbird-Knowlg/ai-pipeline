import { isRetryableModelError } from '@ai-pipeline/ai/errors';
import type { Generate } from '@ai-pipeline/ai/generate';
import { summaryApi } from '@ai-pipeline/contract-summary/api';
import { serviceOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { SUMMARY_SYSTEM, summaryPrompt } from './prompt.js';
import { config, metadata } from './unit.js';

/**
 * One durable LLM step.
 *
 * `generate` is injected so the service can be run against a fake model — that is how the replay
 * test proves the step is journaled exactly once across replays.
 */
export function createSummaryService(generate: Generate) {
  return restate.implement(summaryApi, {
    handlers: {
      summarize: async (ctx, { text, maxWords }) => {
        // Abandon the model call when this attempt ends (cancel, suspension, retry).
        const signal = ctx.request().attemptCompletedSignal;
        const result = await ctx.run(
          'llm.generate-summary',
          async () => {
            try {
              return await generate({
                model: config.model,
                system: SUMMARY_SYSTEM,
                prompt: summaryPrompt(text, maxWords),
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
          },
          retry.llm,
        );
        const summary = result.text.trim();
        if (!summary) throw new restate.TerminalError('the model returned an empty summary');
        return { summary, model: result.model };
      },
    },
    options: serviceOptions(metadata),
  });
}
