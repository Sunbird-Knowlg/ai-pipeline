import { isRetryableModelError } from '@ai-pipeline/ai/errors';
import type { Generate } from '@ai-pipeline/ai/generate';
import { quizGenerateApi } from '@ai-pipeline/contract-quiz-generate/api';
import { serviceOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { QUIZ_SYSTEM, parseQuestions, quizPrompt } from './prompt.js';
import { config, metadata } from './unit.js';

/**
 * One durable LLM step, the same shape as `services/summary` and `services/content-metadata`.
 *
 * The failure modes are worth reading in order, because each is handled differently:
 *
 * - the gateway or the model was unavailable — retry, which `retry.llm` does indefinitely, pausing
 *   the run rather than losing it;
 * - the model refused — terminal, there is no point asking again;
 * - some questions came back malformed — keep the rest and report `discarded`;
 * - *none* survived — terminal. The call is made at temperature 0, so a second attempt gets the
 *   same reply, and an empty quiz is not a result the contract admits.
 */
export function createQuizGenerateService(generate: Generate) {
  return restate.implement(quizGenerateApi, {
    handlers: {
      generate: async (ctx, { text, questionCount, focus }) => {
        // Abandon the model call when this attempt ends (cancel, suspension, retry).
        const signal = ctx.request().attemptCompletedSignal;
        const quiz = await ctx.run(
          'llm.generate-quiz',
          async () => {
            let result;
            try {
              result = await generate({
                model: config.model,
                system: QUIZ_SYSTEM,
                prompt: quizPrompt(text, questionCount, focus),
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
            const { questions, discarded } = parseQuestions(result.text);
            if (questions.length === 0)
              throw new restate.TerminalError(
                `the model returned no usable questions (${discarded} discarded)`,
              );
            return { questions, discarded, model: result.model };
          },
          retry.llm,
        );
        // The caller asked for `questionCount`; a model that writes more does not get to decide.
        return { ...quiz, questions: quiz.questions.slice(0, questionCount) };
      },
    },
    options: serviceOptions(metadata),
  });
}
