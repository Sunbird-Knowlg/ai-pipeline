import { z } from 'zod';

/**
 * The `whisper` contract's data shapes. Kept apart from `./api.ts` so the catalogue side of the
 * contract — what the deploy CLI turns into JSON Schema — needs no Restate SDK.
 */

export const WhisperInput = z.strictObject({
  artifactUrl: z.url(),
  language: z.string().min(2).max(10).optional(),
});
export type WhisperInput = z.infer<typeof WhisperInput>;

export const WhisperSegment = z.strictObject({
  id: z.number().int().nonnegative(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type WhisperSegment = z.infer<typeof WhisperSegment>;

export const WhisperOutput = z.strictObject({
  language: z.string(),
  languageProbability: z.number(),
  duration: z.number(),
  segments: z.array(WhisperSegment),
});
export type WhisperOutput = z.infer<typeof WhisperOutput>;
