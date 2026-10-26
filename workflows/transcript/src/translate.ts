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

/** Per-segment token budget for a translation call; doubled on each truncated retry. */
const BASE_TOKENS_PER_SEGMENT = 60;
const BASE_TOKEN_BUDGET_FLOOR = 1024;
const BASE_TOKEN_BUDGET_HEADROOM = 2000;
/** Hard ceiling so a runaway doubling sequence can't request an absurd budget. */
const MAX_TOKEN_BUDGET = 32_000;
/** Budget-doubling attempts on one chunk before splitting it in half and recursing. */
const MAX_BUDGET_ATTEMPTS = 3;

function baseBudgetFor(chunkSize: number): number {
  return Math.max(chunkSize * BASE_TOKENS_PER_SEGMENT, BASE_TOKEN_BUDGET_FLOOR) +
    BASE_TOKEN_BUDGET_HEADROOM;
}

/** Returns `null` instead of throwing, so a bad parse is just another retryable attempt. */
function tryParseTranslatedBatch(text: string): z.infer<typeof TranslatedBatch> | null {
  const jsonStart = text.indexOf('[');
  const jsonEnd = text.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) return null;
  try {
    const result = TranslatedBatch.safeParse(JSON.parse(text.slice(jsonStart, jsonEnd + 1)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Translates one chunk, retrying with a doubled budget on an incomplete response, then splitting
 * the chunk in half and recursing if that's still not enough. Reasoning-model token usage varies
 * per call and can't be predicted, so a single-segment chunk is the fallback that's reliably small
 * enough to succeed; recursion depth is bounded by log2(chunk length).
 */
async function translateChunk(
  ctx: restate.Context,
  generate: Generate,
  log: Logger,
  chunk: TranscriptSegment[],
  targetLanguage: string,
  languageName: string,
  model: string,
  stepKey: string,
): Promise<z.infer<typeof TranslatedBatch>> {
  let budget = baseBudgetFor(chunk.length);

  for (let attempt = 0; attempt < MAX_BUDGET_ATTEMPTS; attempt++) {
    const result = await ctx.run(
      `llm.translate-${targetLanguage}-${stepKey}-try${attempt}`,
      async () => {
        try {
          return await generate({
            model,
            prompt: translationPrompt(languageName, chunk),
            temperature: 0,
            maxOutputTokens: budget,
          });
        } catch (error) {
          if (isRetryableModelError(error)) {
            log.warn(
              { event: 'translate.retry', targetLanguage, stepKey, err: error },
              'translation model call failed, retrying',
            );
            throw error;
          }
          log.error(
            { event: 'translate.rejected', targetLanguage, stepKey, err: error },
            'translation model rejected chunk',
          );
          throw new restate.TerminalError(
            `translation model rejected chunk ${stepKey} for ${targetLanguage}: ${(error as Error).message}`,
          );
        }
      },
      { initialRetryInterval: { seconds: 2 }, maxRetryInterval: { seconds: 60 } },
    );

    const parsed = tryParseTranslatedBatch(result.text);
    const complete = parsed !== null && chunk.every((s) => parsed.some((p) => p.id === s.id));
    if (complete) return parsed;

    log.warn(
      {
        event: 'translate.incomplete_attempt',
        targetLanguage,
        stepKey,
        attempt,
        budget,
        finishReason: result.finishReason,
        outputTokens: result.usage.outputTokens,
      },
      'translation attempt incomplete, retrying with a larger budget',
    );
    budget = Math.min(budget * 2, MAX_TOKEN_BUDGET);
  }

  const [only] = chunk;
  if (chunk.length === 1 && only) {
    log.error(
      { event: 'translate.exhausted', targetLanguage, stepKey, segmentId: only.id },
      'translation repeatedly incomplete even at a single segment',
    );
    throw new restate.TerminalError(
      `translation for ${targetLanguage} segment ${only.id} failed after exhausting retries`,
    );
  }
  const mid = Math.floor(chunk.length / 2);
  const left = await translateChunk(
    ctx,
    generate,
    log,
    chunk.slice(0, mid),
    targetLanguage,
    languageName,
    model,
    `${stepKey}-L`,
  );
  const right = await translateChunk(
    ctx,
    generate,
    log,
    chunk.slice(mid),
    targetLanguage,
    languageName,
    model,
    `${stepKey}-R`,
  );
  return [...left, ...right];
}

/**
 * Translates a full segment list into one target language, batching to stay within the model's
 * context window (`batchSize`, with `overlap` segments of leading context per batch after the
 * first). Each batch is translated via `translateChunk`, which retries and splits on an
 * incomplete response rather than failing the whole translation on one bad call.
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
  const startedAt = await ctx.date.now();
  log.info(
    {
      event: 'translate.start',
      targetLanguage,
      batches: batches.length,
      segments: segments.length,
      batchSize,
      overlap,
    },
    'starting translation',
  );

  for (const [index, { batch, newFrom }] of batches.entries()) {
    const batchStartedAt = await ctx.date.now();
    log.debug(
      {
        event: 'translate.batch_start',
        targetLanguage,
        batch: index,
        of: batches.length,
        segmentIds: batch.map((s) => s.id),
      },
      'translating batch',
    );

    const parsed = await translateChunk(
      ctx,
      generate,
      log,
      batch,
      targetLanguage,
      languageName,
      model,
      `batch-${index}`,
    );
    const byId = new Map(parsed.map((item) => [item.id, item.text]));
    for (const seg of batch.slice(newFrom)) {
      const text = byId.get(seg.id);
      // Safety net; translateChunk should never return with an id missing.
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
      {
        event: 'translate.batch_complete',
        targetLanguage,
        batch: index,
        segments: batch.length,
        elapsedMs: (await ctx.date.now()) - batchStartedAt,
      },
      'translation batch complete',
    );
  }

  log.info(
    { event: 'translate.complete', targetLanguage, elapsedMs: (await ctx.date.now()) - startedAt },
    'translation complete',
  );
  return segments.map((seg) => ({ ...seg, text: translatedById.get(seg.id) ?? seg.text }));
}
