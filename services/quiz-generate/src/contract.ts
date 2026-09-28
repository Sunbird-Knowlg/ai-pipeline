import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import {
  QuizGenerateConfig,
  QuizGenerateInput,
  QuizGenerateOutput,
} from '@ai-pipeline/contract-quiz-generate';

/**
 * The catalogue view of this unit's contract, registered by `serve()` on boot.
 *
 * The schemas themselves live in `@ai-pipeline/contract-quiz-generate` rather than here, because
 * `content-authoring` calls this service and needs them too.
 */
export const contract: ContractEntry = {
  restateName: 'QuizGenerateService',
  handler: 'generate',
  input: QuizGenerateInput,
  output: QuizGenerateOutput,
  config: QuizGenerateConfig,
};
