import { z } from 'zod';
import { type ContentAuthoringInput, DikshaContentEvent } from './schemas.js';

const Envelope = z.looseObject({
  objectType: z.string().optional(),
  edata: z.looseObject({ state: z.string().nullish() }).optional(),
});

/** DIKSHA names languages in full; the rest of the pipeline speaks ISO codes. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  english: 'en',
  hindi: 'hi',
  bengali: 'bn',
  marathi: 'mr',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  gujarati: 'gu',
};

/**
 * DIKSHA sends `subject`, `gradeLevel` and `language` sometimes as a string and sometimes as an
 * array of them. Take the first usable string and move on — this is metadata, not a reason to
 * reject a record.
 */
function first(value: unknown): string | undefined {
  // `Array.isArray` narrows `unknown` to `any[]`, so the element type has to be restated.
  const candidate: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Trigger adapters: pure maps from a trigger's event to `ContentAuthoringInput`.
 *
 * Three outcomes, and the difference matters operationally:
 *
 * - a mapped input starts a run;
 * - `null` drops the record silently — it was never this workflow's business;
 * - throwing fails the record terminally, which Restate logs and never retries, so one malformed
 *   record cannot wedge the partition.
 *
 * The rule of thumb: be silent about events that are not ours, and loud about ones that are but
 * arrived broken. A `Live` Content with no text is a producer bug, and hiding it helps nobody.
 */
export const adapters = {
  dikshaContentPublished(event: unknown): ContentAuthoringInput | null {
    // The topic carries the whole object lifecycle for every object type.
    const envelope = Envelope.safeParse(event);
    if (envelope.success) {
      const { objectType, edata } = envelope.data;
      if (objectType && objectType !== 'Content') return null;
      if (edata?.state && edata.state !== 'Live') return null;
    }

    const e = DikshaContentEvent.parse(event);
    // Whichever of these the platform filled in: a video has a transcript, an explainer a body,
    // and a link nothing but its description.
    const text = e.edata.body ?? e.edata.transcript ?? e.edata.description ?? '';
    if (text.trim() === '')
      throw new Error(
        `content ${e.identifier} is Live but carries no body, transcript or description`,
      );

    const language = first(e.edata.language);
    return {
      contentId: e.identifier,
      name: e.edata.name,
      ...(e.edata.description ? { description: e.edata.description } : {}),
      text,
      ...(first(e.edata.subject) ? { subject: first(e.edata.subject)! } : {}),
      ...(first(e.edata.gradeLevel) ? { gradeLevel: first(e.edata.gradeLevel)! } : {}),
      language: language ? (LANGUAGE_CODES[language.toLowerCase()] ?? language) : 'en',
    };
  },
};
