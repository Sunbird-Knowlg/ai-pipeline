import type { RunOptions } from '@restatedev/restate-sdk';

/** Shared backoff shape for plain HTTP APIs; `http` and `httpResumable` differ only in the cap. */
const httpBackoff = {
  initialRetryInterval: { milliseconds: 500 },
  maxRetryInterval: { seconds: 10 },
};

/**
 * Presets for `ctx.run(name, fn, retry.x)`. Override freely — these are defaults, not a policy
 * engine. A capped profile throws a TerminalError when exhausted (the run fails); an uncapped
 * one leaves exhaustion to the invocation retry policy, which pauses the invocation instead.
 */
export const retry = {
  /**
   * LLM calls: slow, rate limited, occasionally unavailable. Uncapped on purpose: a gateway or
   * model outage pauses the run (resumable) instead of failing it. Throw a TerminalError for
   * non-retryable model errors (see `isRetryableModelError`).
   */
  llm: {
    initialRetryInterval: { seconds: 2 },
    maxRetryInterval: { seconds: 60 },
  },
  /** Plain HTTP APIs. */
  http: { maxRetryAttempts: 5, ...httpBackoff },
  /**
   * `http`, uncapped: for a step whose failure would discard already-completed, expensive
   * upstream work (e.g. a multi-minute transcription) rather than just retrying something cheap.
   * Same reasoning as `llm` -- an outage pauses the run (resumable, upstream work stays in the
   * journal) instead of failing it and throwing that work away.
   */
  httpResumable: { ...httpBackoff },
  /** Database reads/writes. */
  db: {
    maxRetryAttempts: 3,
    initialRetryInterval: { milliseconds: 100 },
    maxRetryInterval: { seconds: 1 },
  },
} satisfies Record<string, RunOptions<unknown>>;
