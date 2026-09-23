import {
  ContentPublishedEvent,
  type ContentInput,
} from '@ai-pipeline/contracts/content-enrichment';
import { z } from 'zod';

const ObjectType = z.looseObject({ objectType: z.string().optional() });

/** Trigger adapters: pure maps from a trigger's event to `ContentInput`; `null` skips the event. */
export const adapters = {
  contentPublished(event: unknown): ContentInput | null {
    // Other object types are not ours: skip them before requiring the Content shape.
    const kind = ObjectType.safeParse(event);
    if (kind.success && kind.data.objectType && kind.data.objectType !== 'Content') return null;
    const e = ContentPublishedEvent.parse(event);
    return {
      contentId: e.identifier,
      ...(e.edata.title ? { title: e.edata.title } : {}),
      text: e.edata.body,
    };
  },
};
