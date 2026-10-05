import type { Generate } from '@ai-pipeline/ai/generate';
import { isRetryableModelError } from '@ai-pipeline/ai/errors';
import type { Logger } from '@ai-pipeline/observability/logger';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';
import type { TranscriptSegment } from './schemas.js';

/**
 * Splits segments into overlapping batches: each batch after the first repeats the previous
 * batch's trailing `overlap` segments as leading context, so the model has continuity across a
 * boundary — but only the batch's *new* segments (from `newFrom` onward) are ever kept in the
 * final translated output; a segment's translation is taken from the one batch where it's new.
 */
export function makeBatches<T>(
  segments: readonly T[],
  batchSize: number,
  overlap: number,
): { batch: T[]; newFrom: number }[] {
  if (segments.length === 0) return [];
  const batches: { batch: T[]; newFrom: number }[] = [];
  let i = 0;
  while (i < segments.length) {
    const batch = segments.slice(i, i + batchSize);
    batches.push({ batch, newFrom: i === 0 ? 0 : overlap });
    if (i + batchSize >= segments.length) break;
    i += batchSize - overlap;
  }
  return batches;
}

const TranslatedSegment = z.object({ id: z.number().int(), text: z.string() });
const TranslatedBatch = z.array(TranslatedSegment);

function translationPrompt(languageName: string, segments: TranscriptSegment[]): string {
  const payload = segments.map((s) => ({ id: s.id, text: s.text }));
  return [
    `Translate each "text" value below into ${languageName}. Keep the meaning natural, not literal.`,
    'Return a JSON array of the same length, each item shaped exactly {"id": <number>, "text": "<translation>"}.',
    'Preserve every "id" unchanged. Do not add, remove, merge or reorder items. Return only the JSON array, nothing else.',
    '',
    JSON.stringify(payload),
  ].join('\n');
}

/**
 * Translates a full segment list into one target language, batching to stay within the model's
 * context window (`batchSize`, with `overlap` segments of leading context per batch after the
 * first) and running each batch as its own durable `ctx.run` step. One bad batch fails the whole
 * translation rather than silently returning partial/misaligned segments.
 */
export async function translateSegments(
  ctx: restate.Context,
  generate: Generate,
  log: Logger,
  segments: TranscriptSegment[],
  targetLanguage: string,
  model: string,
  batchSize: number,
  overlap: number,
): Promise<TranscriptSegment[]> {
  const languageName =
    new Intl.DisplayNames(['en'], { type: 'language' }).of(targetLanguage) ?? targetLanguage;
  const batches = makeBatches(segments, batchSize, overlap);
  const translatedById = new Map<number, string>();
  log.info(
    { event: 'translate.start', targetLanguage, batches: batches.length },
    'starting translation',
  );

  for (const [index, { batch, newFrom }] of batches.entries()) {
    const result = await ctx.run(
      `llm.translate-${targetLanguage}-batch-${index}`,
      async () => {
        try {
          return await generate({
            model,
            prompt: translationPrompt(languageName, batch),
            temperature: 0,
          });
        } catch (error) {
          if (isRetryableModelError(error)) {
            log.warn(
              { event: 'translate.retry', targetLanguage, batch: index, err: error },
              'translation model call failed, retrying',
            );
            throw error;
          }
          log.error(
            { event: 'translate.rejected', targetLanguage, batch: index, err: error },
            'translation model rejected batch',
          );
          throw new restate.TerminalError(
            `translation model rejected batch ${index} for ${targetLanguage}: ${(error as Error).message}`,
          );
        }
      },
      { initialRetryInterval: { seconds: 2 }, maxRetryInterval: { seconds: 60 } },
    );

    const parsed = parseTranslatedBatch(result.text, targetLanguage, index, log);
    const byId = new Map(parsed.map((item) => [item.id, item.text]));
    for (const seg of batch.slice(newFrom)) {
      const text = byId.get(seg.id);
      if (text === undefined) {
        log.error(
          { event: 'translate.missing_segment', targetLanguage, batch: index, segmentId: seg.id },
          'translation batch is missing a segment id',
        );
        throw new restate.TerminalError(
          `translation batch ${index} for ${targetLanguage} is missing segment id ${seg.id}`,
        );
      }
      translatedById.set(seg.id, text);
    }
    log.debug(
      { event: 'translate.batch_complete', targetLanguage, batch: index, segments: batch.length },
      'translation batch complete',
    );
  }

  log.info({ event: 'translate.complete', targetLanguage }, 'translation complete');
  return segments.map((seg) => ({ ...seg, text: translatedById.get(seg.id) ?? seg.text }));
}

function parseTranslatedBatch(
  text: string,
  targetLanguage: string,
  batchIndex: number,
  log: Logger,
): z.infer<typeof TranslatedBatch> {
  const jsonStart = text.indexOf('[');
  const jsonEnd = text.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) {
    log.error(
      { event: 'translate.no_json', targetLanguage, batch: batchIndex },
      'translation batch did not return a JSON array',
    );
    throw new restate.TerminalError(
      `translation batch ${batchIndex} for ${targetLanguage} did not return a JSON array`,
    );
  }
  try {
    return TranslatedBatch.parse(JSON.parse(text.slice(jsonStart, jsonEnd + 1)));
  } catch (error) {
    log.error(
      { event: 'translate.malformed_json', targetLanguage, batch: batchIndex, err: error },
      'translation batch returned malformed JSON',
    );
    throw new restate.TerminalError(
      `translation batch ${batchIndex} for ${targetLanguage} returned malformed JSON: ${(error as Error).message}`,
    );
  }
}
