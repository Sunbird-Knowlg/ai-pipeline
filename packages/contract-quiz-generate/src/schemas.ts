import { z } from 'zod';

/**
 * The `quiz-generate` contract's data shapes. Kept apart from `./api.ts` so the catalogue side of
 * the contract — what the deploy CLI turns into JSON Schema — needs no Restate SDK.
 *
 * These live in a package rather than in `services/quiz-generate` because a *second* unit needs
 * them: `workflows/content-authoring` calls this service and has to type the call.
 */

export const QUIZ_TEXT_MAX = 40_000;
export const QUIZ_MAX_QUESTIONS = 10;
export const QUIZ_OPTION_COUNT = 4;

/**
 * One multiple-choice question. `answerIndex` points into `options`, and the schema is what keeps
 * the pair honest: exactly four options, and an index that can only be one of them.
 */
export const QuizQuestion = z.strictObject({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(300)).length(QUIZ_OPTION_COUNT),
  answerIndex: z
    .number()
    .int()
    .min(0)
    .max(QUIZ_OPTION_COUNT - 1),
});
export type QuizQuestion = z.infer<typeof QuizQuestion>;

export const QuizGenerateInput = z.strictObject({
  text: z.string().min(1).max(QUIZ_TEXT_MAX),
  questionCount: z.number().int().min(1).max(QUIZ_MAX_QUESTIONS),
  /** Concepts the quiz should examine. Empty leaves the choice to the model. */
  focus: z.array(z.string().min(1).max(80)).max(8),
});
export type QuizGenerateInput = z.infer<typeof QuizGenerateInput>;

export const QuizGenerateOutput = z.strictObject({
  /** At least one: a quiz with no questions is a failure, not an empty result. */
  questions: z.array(QuizQuestion).min(1).max(QUIZ_MAX_QUESTIONS),
  /** Items the model returned that did not survive validation. Worth watching over time. */
  discarded: z.number().int().nonnegative(),
  model: z.string(),
});
export type QuizGenerateOutput = z.infer<typeof QuizGenerateOutput>;

export const QuizGenerateConfig = z.strictObject({
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().default(1200),
});
export type QuizGenerateConfig = z.infer<typeof QuizGenerateConfig>;
