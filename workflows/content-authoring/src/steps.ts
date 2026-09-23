import type { ContentAuthoringInput } from './schemas.js';

/**
 * Steps: deterministic helpers that run inside the workflow's handler.
 *
 * A step is a plain function in the unit that owns it — not a Restate service, not catalogued, not
 * journaled. It runs again on every replay, which is exactly why it must be pure: same input, same
 * output, no clock, no randomness, no I/O. In exchange it costs nothing to run and is trivial to
 * unit test. Anything that talks to the outside world belongs in a service, or in `ctx.run`.
 */

/**
 * The text the three services see.
 *
 * Title first, then the blurb, then the body — a summary that ignores the title of the thing it is
 * summarising reads badly, and a quiz about "the passage" should know what the passage is called.
 */
export function authoringText(input: ContentAuthoringInput): string {
  return [input.name, input.description, input.text].filter(Boolean).join('\n\n');
}

/** Reading time at 200 words per minute, rounded to a tenth — the usual editorial convention. */
export function textStats(text: string): { wordCount: number; readingTimeMinutes: number } {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return { wordCount, readingTimeMinutes: Math.round((wordCount / 200) * 10) / 10 };
}
