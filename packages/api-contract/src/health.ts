import { z } from 'zod';

export const liveness = z.object({ status: z.literal('ok') });
export type Liveness = z.infer<typeof liveness>;

/** Ready means both stores answer: Postgres holds the catalogue, Restate holds the runs. */
export const readiness = z.object({
  status: z.enum(['ready', 'not_ready']),
  dependencies: z.object({ postgres: z.boolean(), restate: z.boolean() }),
});
export type Readiness = z.infer<typeof readiness>;
