import { z } from 'zod';
import type { TranscriptInput } from './schemas.js';

/**
 * knowlg-publish's generic content-published event — fired exactly once for every Content/
 * Collection/Question/QuestionSet publish, always, whether or not any enrichment was requested.
 * `edata.enrichmentTypes` carries the node's own array verbatim (`[]` when none). `edata` is
 * deliberately objectType-agnostic beyond what's here (no `artifactUrl`): this workflow reads
 * whatever it needs itself, from knowlg, once it has `identifier`.
 */
const ContentPublishedEvent = z.object({
  eid: z.literal('BE_JOB_REQUEST'),
  edata: z.looseObject({
    action: z.literal('content-published'),
    identifier: z.string().min(1),
    objectType: z.string().min(1),
    mimeType: z.string().min(1),
    channel: z.string().min(1).optional(),
    enrichmentTypes: z.array(z.string()),
  }),
});

/** knowlg-publish applies no mimeType gate at all — every publish fires this event regardless.
 *  So this workflow's own eligibility check (does this even make sense as a video) lives here,
 *  the only place that actually knows what Transcript needs. */
const TRANSCRIPT_MIME_TYPES = ['video/mp4', 'video/webm'];

/**
 * Trigger adapters: pure maps from an event to this workflow's canonical input. Returning `null`
 * drops the record without starting a run — used here for every content-published event that
 * isn't asking for a Transcript, or isn't a Content, or isn't a video. Throwing fails the record
 * terminally, so a malformed one never blocks the partition.
 */
export const adapters = {
  contentPublishedEvent(event: unknown): TranscriptInput | null {
    const parsed = ContentPublishedEvent.parse(event);
    const { edata } = parsed;
    if (!edata.enrichmentTypes.includes('Transcript')) return null;
    if (edata.objectType !== 'Content') return null;
    if (!TRANSCRIPT_MIME_TYPES.includes(edata.mimeType)) return null;
    return {
      identifier: edata.identifier,
      objectType: edata.objectType,
      mimeType: edata.mimeType,
      channel: edata.channel ?? 'all',
    };
  },
};
