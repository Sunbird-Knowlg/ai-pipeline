import { APICallError } from 'ai';

/**
 * Whether a failed model call is worth retrying. Client errors (bad request, context too long,
 * auth) are not; timeouts, rate limits, 5xx and network errors are.
 *
 * Callers turn a `false` into a `TerminalError` so Restate stops retrying the step.
 */
export function isRetryableModelError(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return true;
}
