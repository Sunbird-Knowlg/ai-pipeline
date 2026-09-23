import { z } from 'zod';

/** Where a run came from. Carried inside the durable request; never derived from the run id. */
export const TriggerContext = z.strictObject({
  type: z.enum(['rest', 'kafka']),
  id: z.string(),
  source: z.string().optional(),
  partition: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().optional(),
  receivedAt: z.number().int(),
});
export type TriggerContext = z.infer<typeof TriggerContext>;

/** The `run` request of every catalogued workflow: canonical input plus trigger context. */
export const runRequest = <T extends z.ZodType>(input: T) =>
  z.strictObject({ input, trigger: TriggerContext });
