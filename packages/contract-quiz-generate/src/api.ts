import * as restate from '@restatedev/restate-sdk';
import { QuizGenerateInput, QuizGenerateOutput } from './schemas.js';

/** The Restate binding for the `quiz-generate` contract: what the implementation and its callers share. */
export const quizGenerateApi = restate.iface.service(
  'QuizGenerateService',
  {
    generate: restate.iface.schemas({
      input: QuizGenerateInput,
      output: QuizGenerateOutput,
    }),
  },
  { description: 'Writes multiple-choice questions from a text (private)' },
);
