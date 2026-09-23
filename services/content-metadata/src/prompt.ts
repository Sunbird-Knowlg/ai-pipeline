import { ContentMetadataOutput, Difficulty } from '@ai-pipeline/contract-content-metadata';

/**
 * The prompt this service sends and how its reply is read back.
 *
 * Both live here, apart from the handler, because they are one decision: the prompt asks for a
 * shape, and `parseMetadata` is what happens when the model answers in a slightly different one. A
 * careless edit to either changes every extraction the pipeline produces, so they are reviewed and
 * tested as text.
 */

export const CONTENT_METADATA_SYSTEM =
  'You extract teaching metadata from a passage. Reply with one JSON object only, ' +
  'no prose and no code fences.';

/** The passage is delimited so that instructions inside it read as content, not as direction. */
export const metadataPrompt = (text: string, maxKeywords: number): string =>
  `Return {"keywords": up to ${maxKeywords} short strings, "concepts": up to 4 short strings, ` +
  `"difficulty": one of ${Difficulty.options.map((d) => `"${d}"`).join(', ')}}. ` +
  `Use only the passage.\n\n<passage>\n${text}\n</passage>`;

/**
 * The first JSON object in a model reply.
 *
 * Models fence their JSON, prefix it with "Here you go:", or append a note — none of which is worth
 * a retry. Slicing between the outer braces costs nothing and rescues most of those replies. It is
 * deliberately not a lenient JSON parser: whatever it returns still goes through the schema.
 */
export function firstJsonObject(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Reads a model reply back into the contract's output shape, or `null` when it says nothing usable.
 *
 * Which model answered is not the model's to state, so the field is filled with a placeholder here
 * and replaced by the handler; a reply that named a different model would otherwise be believed.
 */
export function parseMetadata(reply: string): Omit<ContentMetadataOutput, 'model'> | null {
  const value = firstJsonObject(reply);
  if (typeof value !== 'object' || value === null) return null;
  const { keywords, concepts, difficulty } = value as Record<string, unknown>;
  const parsed = ContentMetadataOutput.safeParse({
    keywords: clean(keywords, KEYWORDS_MAX),
    concepts: clean(concepts, CONCEPTS_MAX),
    difficulty,
    model: 'unchecked',
  });
  if (!parsed.success) return null;
  const { model: _ignored, ...metadata } = parsed.data;
  return metadata;
}

/** The caps the contract puts on each list. Restated here so `clean` can honour them. */
const KEYWORDS_MAX = 20;
const CONCEPTS_MAX = 8;

/**
 * Strings only, trimmed, de-duplicated, blanks dropped, and capped at what the contract accepts.
 *
 * The cap is the point: a model that ignores "up to 8" and returns thirty keywords has still done
 * the job, and failing the whole run over the surplus would be the wrong trade. What it may not do
 * is return a payload larger than the contract admits.
 */
function clean(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
    if (seen.size === max) break;
  }
  return [...seen];
}
