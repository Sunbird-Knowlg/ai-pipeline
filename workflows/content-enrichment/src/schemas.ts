import { z } from 'zod';
import { runRequest } from '@ai-pipeline/contracts/trigger';

/**
 * The `content-enrichment` contract's data shapes. Kept apart from `./api.ts` so the catalogue side
 * of the contract — what the deploy CLI turns into JSON Schema — needs no Restate SDK.
 */

export const ContentInput = z.strictObject({
  contentId: z.string().min(1).max(256),
  title: z.string().max(1000).optional(),
  text: z.string().min(1).max(100_000),
});
export type ContentInput = z.infer<typeof ContentInput>;

export const ContentOutput = z.strictObject({
  contentId: z.string(),
  summary: z.string(),
  metadata: z.strictObject({
    wordCount: z.number().int(),
    charCount: z.number().int(),
    readingTimeMinutes: z.number(),
    model: z.string(),
    trigger: z.enum(['rest', 'kafka']),
    enrichedAt: z.number().int(),
  }),
});
export type ContentOutput = z.infer<typeof ContentOutput>;

export const ContentConfig = z.strictObject({
  summaryMaxWords: z.number().int().min(10).max(1000),
});
export type ContentConfig = z.infer<typeof ContentConfig>;

/** The `content.published` Kafka event as producers emit it (mapped by the trigger adapter). */
export const ContentPublishedEvent = z.looseObject({
  identifier: z.string().min(1),
  objectType: z.string().optional(),
  edata: z.looseObject({
    title: z.string().nullish(),
    body: z.string().min(1),
  }),
});
export type ContentPublishedEvent = z.infer<typeof ContentPublishedEvent>;

export const ContentEnrichmentRequest = runRequest(ContentInput);
export type ContentEnrichmentRequest = z.infer<typeof ContentEnrichmentRequest>;
