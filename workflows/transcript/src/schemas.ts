import { runRequest } from '@ai-pipeline/contracts/trigger';
import { z } from 'zod';

/**
 * This workflow's data shapes. Kept apart from `./api.ts` so the catalogue side needs no SDK.
 */

/**
 * Content this workflow can actually transcribe. The Kafka adapter applies this before a run ever
 * starts; `run` applies it again for the REST trigger, which has no adapter of its own to gate it.
 */
export const TRANSCRIPT_MIME_TYPES = ['video/mp4', 'video/webm'];

export function isTranscriptEligible(objectType: string, mimeType: string): boolean {
  return objectType === 'Content' && TRANSCRIPT_MIME_TYPES.includes(mimeType);
}

/** The generic enrichment-request event, mapped by the trigger adapter to just what this workflow needs. */
export const TranscriptInput = z.strictObject({
  /** The Content (or other objectType) this Transcript attaches to. knowlg-client interpolates
   *  this into REST paths (percent-encoded); restricting the character set here, not just there,
   *  keeps a `../` or `?` out before it ever reaches a URL. */
  identifier: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_.-]+$/, 'identifier must be alphanumeric (with _.- allowed)'),
  objectType: z.string().min(1).max(100),
  mimeType: z.string().min(1).max(200),
  channel: z.string().min(1).max(200).default('all'),
  /** The Content's current artifact fingerprint, when the event carries one. Lets a run tell a
   *  resumed/replayed trigger (same artifact) apart from a re-publish with a replaced video
   *  (different artifact) — see `createOrRefreshNode` in workflow.ts. */
  artifactHash: z.string().min(1).max(128).optional(),
});
export type TranscriptInput = z.infer<typeof TranscriptInput>;

const TranscriptResult = z.strictObject({
  identifier: z.string(),
  languageCode: z.string(),
  status: z.string(),
});

export const TranscriptOutput = z.strictObject({
  parentId: z.string(),
  source: TranscriptResult,
  translations: z.array(TranscriptResult),
});
export type TranscriptOutput = z.infer<typeof TranscriptOutput>;

export const TranscriptConfig = z.strictObject({
  /** Target languages translated from the source transcript, each its own Transcript sibling. */
  targetLanguages: z.array(z.string().min(2).max(10)).default(['ar', 'pt', 'fr']),
  /** LiteLLM `model_name` used for translation. */
  translationModel: z.string().min(1),
  /** Segments per translation batch, and how many trailing segments of the previous batch are
   *  repeated as leading context in the next one (never re-emitted, just there for continuity). */
  translationBatchSize: z.number().int().min(1).max(500).default(80),
  translationBatchOverlap: z.number().int().min(0).max(50).default(2),
});
export type TranscriptConfig = z.infer<typeof TranscriptConfig>;

/** The `run` request: canonical input plus the trigger context the control plane attaches. */
export const TranscriptRequest = runRequest(TranscriptInput);
export type TranscriptRequest = z.infer<typeof TranscriptRequest>;

/** One Whisper-produced segment — the unit both captioning and translation work on. */
export const TranscriptSegment = z.strictObject({
  id: z.number().int().nonnegative(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/**
 * The three fields this workflow actually reads off knowlg's generic EnrichmentObject response
 * (create/approve) — `@ai-pipeline/knowlg-client` returns the raw response, this workflow parses
 * only what it needs. `languageCode` is only present when `create()`'s `uniqueOn` matching
 * returned an *existing* sibling rather than a brand-new node — see `createEnrichmentObject`'s
 * own doc comment in the client.
 */
export const EnrichmentObjectResult = z.object({
  identifier: z.string(),
  status: z.string(),
  languageCode: z.string().optional(),
  /** Set when a prior run stamped one via `updateEnrichmentObject` — absent on a brand-new node. */
  artifactHash: z.string().optional(),
});
export type EnrichmentObjectResult = z.infer<typeof EnrichmentObjectResult>;
