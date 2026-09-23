import type { PipelineErrorCode } from '@ai-pipeline/api-contract/errors';

/**
 * A refusal the API reports as `{ error: { code, message } }`.
 *
 * `code` is the shared wire union, not a free string: the deploy CLI branches on these codes, so a
 * typo or a rename has to fail the build rather than change deploy behaviour in the field.
 */
export class PipelineError extends Error {
  constructor(
    public readonly code: PipelineErrorCode,
    message: string,
    public readonly statusCode = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PipelineError';
  }
}

export function assert(
  condition: unknown,
  code: PipelineErrorCode,
  message: string,
  statusCode = 400,
): asserts condition {
  if (!condition) throw new PipelineError(code, message, statusCode);
}

export const notFound = (what: string) => new PipelineError('NOT_FOUND', `${what} not found`, 404);
