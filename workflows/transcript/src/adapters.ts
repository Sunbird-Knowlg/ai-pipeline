import type { Logger } from '@ai-pipeline/observability/logger';
import { z } from 'zod';
import { TRANSCRIPT_MIME_TYPES, type TranscriptInput } from './schemas.js';

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

/**
 * Just enough to decide whether this event is ours, without requiring the full shape above. The
 * topic carries every publish of every object type, always — a Collection or Question publish has
 * no `mimeType` at all, and must be skipped as "not mine" rather than fail the strict parse below
 * as "malformed".
 */
const EligibilityGate = z.looseObject({
  edata: z
    .looseObject({
      identifier: z.string().optional(),
      objectType: z.string().optional(),
      mimeType: z.string().optional(),
      enrichmentTypes: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Trigger adapters: pure maps from an event to this workflow's canonical input. Returning `null`
 * drops the record without starting a run — used here for every content-published event that
 * isn't asking for a Transcript, or isn't a Content, or isn't a video. Throwing fails the record
 * terminally, so a malformed one never blocks the partition.
 */
export const adapters = {
  contentPublishedEvent(event: unknown, log: Logger): TranscriptInput | null {
    const gate = EligibilityGate.safeParse(event);
    const edata = gate.success ? gate.data.edata : undefined;
    if (!edata?.enrichmentTypes?.includes('Transcript')) {
      log.debug(
        { event: 'adapter.skip', reason: 'enrichmentTypes', identifier: edata?.identifier },
        'skipped: Transcript not requested',
      );
      return null;
    }
    if (edata.objectType !== 'Content') {
      log.debug(
        {
          event: 'adapter.skip',
          reason: 'objectType',
          identifier: edata.identifier,
          objectType: edata.objectType,
        },
        'skipped: not a Content',
      );
      return null;
    }
    if (!edata.mimeType || !TRANSCRIPT_MIME_TYPES.includes(edata.mimeType)) {
      log.debug(
        {
          event: 'adapter.skip',
          reason: 'mimeType',
          identifier: edata.identifier,
          mimeType: edata.mimeType,
        },
        'skipped: not a supported video mimeType',
      );
      return null;
    }
    // Known relevant from here on — now worth failing the record terminally if malformed.
    const { edata: parsed } = ContentPublishedEvent.parse(event);
    log.info(
      { event: 'adapter.accept', identifier: parsed.identifier, mimeType: parsed.mimeType },
      'accepted: dispatching Transcript run',
    );
    return {
      identifier: parsed.identifier,
      objectType: parsed.objectType,
      mimeType: parsed.mimeType,
      channel: parsed.channel ?? 'all',
    };
  },
};
