import { z } from 'zod';

/**
 * The `content-metadata` contract's data shapes. Kept apart from `./api.ts` so the catalogue side of
 * the contract — what the deploy CLI turns into JSON Schema — needs no Restate SDK.
 *
 * These live in a package rather than in `services/content-metadata` because a *second* unit needs
 * them: `workflows/content-authoring` calls this service and has to type the call.
 */

/** One learning resource's text. Generous, but well inside the model's context window. */
export const METADATA_TEXT_MAX = 40_000;

/** How hard the material is, as a closed set: a caller can `switch` on it. */
export const Difficulty = z.enum(['beginner', 'intermediate', 'advanced']);
export type Difficulty = z.infer<typeof Difficulty>;

export const ContentMetadataInput = z.strictObject({
  text: z.string().min(1).max(METADATA_TEXT_MAX),
  /** Upper bound on the keyword list; the model is told the same number. */
  maxKeywords: z.number().int().min(3).max(20),
});
export type ContentMetadataInput = z.infer<typeof ContentMetadataInput>;

export const ContentMetadataOutput = z.strictObject({
  /** Surface terms, in the words of the text. */
  keywords: z.array(z.string().min(1).max(60)).max(20),
  /** The ideas behind them — what a quiz should actually examine. */
  concepts: z.array(z.string().min(1).max(80)).max(8),
  difficulty: Difficulty,
  model: z.string(),
});
export type ContentMetadataOutput = z.infer<typeof ContentMetadataOutput>;

export const ContentMetadataConfig = z.strictObject({
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().default(512),
});
export type ContentMetadataConfig = z.infer<typeof ContentMetadataConfig>;
