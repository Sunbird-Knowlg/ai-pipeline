import { z } from 'zod';

/**
 * The `summary` contract's data shapes. Kept apart from `./api.ts` so the catalogue side of the
 * contract — what the deploy CLI turns into JSON Schema — needs no Restate SDK.
 */

/** Large enough for a workflow's title + text (see content-enrichment's ContentInput). */
export const SUMMARY_TEXT_MAX = 110_000;

export const SummaryInput = z.strictObject({
  text: z.string().min(1).max(SUMMARY_TEXT_MAX),
  maxWords: z.number().int().min(10).max(1000),
});
export type SummaryInput = z.infer<typeof SummaryInput>;

export const SummaryOutput = z.strictObject({
  summary: z.string(),
  model: z.string(),
});
export type SummaryOutput = z.infer<typeof SummaryOutput>;

export const SummaryConfig = z.strictObject({
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().default(512),
});
export type SummaryConfig = z.infer<typeof SummaryConfig>;
