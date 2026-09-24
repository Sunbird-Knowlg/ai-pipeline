import { z } from 'zod';

/** Where a run came from. Carried inside the durable request; never derived from the run id. */
export const TriggerContext = z.strictObject({
  type: z.enum(['rest', 'kafka']),
  id: z.string(),
  source: z.string().optional(),
  partition: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().optional(),
  /**
   * Digest of the canonical input this run was started with.
   *
   * The handler records the whole trigger context in workflow state, which is what lets the control
   * plane answer the question an idempotency key really asks: is this the *same* request? Without
   * it, reusing a key with a different body is answered `202 PreviouslyAccepted` and the new work
   * is silently dropped.
   *
   * Best-effort, deliberately: the handler writes this as its first act, so a second submit that
   * arrives before it does has nothing to compare against and is answered `PreviouslyAccepted`
   * without the check. See `assertSameRequest` in the core API for why that beats failing closed.
   */
  inputDigest: z.string().optional(),
  receivedAt: z.number().int(),
});
export type TriggerContext = z.infer<typeof TriggerContext>;

/** The `run` request of every catalogued workflow: canonical input plus trigger context. */
export const runRequest = <T extends z.ZodType>(input: T) =>
  z.strictObject({ input, trigger: TriggerContext });
