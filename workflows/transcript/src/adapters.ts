import { z } from 'zod';
import type { TranscriptInput } from './schemas.js';

/**
 * The generic enrichment-request event, as knowlg-publish emits it — one event per requested
 * `enrichmentType`, deliberately objectType-agnostic (no `artifactUrl`, no Content-specific
 * fields): this workflow reads whatever it needs itself, from knowlg, once it has `identifier`.
 */
const EnrichmentRequestEvent = z.looseObject({
  identifier: z.string().min(1),
  objectType: z.string().min(1),
  mimeType: z.string().min(1),
  channel: z.string().min(1).optional(),
  enrichmentType: z.string().min(1),
});

/**
 * Trigger adapters: pure maps from an event to this workflow's canonical input. Returning `null`
 * drops the record without starting a run — used here for every enrichment-request event that
 * isn't asking for a Transcript. Throwing fails the record terminally, so a malformed one never
 * blocks the partition.
 */
export const adapters = {
  enrichmentRequestEvent(event: unknown): TranscriptInput | null {
    const parsed = EnrichmentRequestEvent.parse(event);
    if (parsed.enrichmentType !== 'Transcript') return null;
    return {
      identifier: parsed.identifier,
      objectType: parsed.objectType,
      mimeType: parsed.mimeType,
      channel: parsed.channel ?? 'all',
    };
  },
};
