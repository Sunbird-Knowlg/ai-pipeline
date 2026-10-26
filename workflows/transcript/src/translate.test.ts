import * as restate from '@restatedev/restate-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { Generate, GenerateResult } from '@ai-pipeline/ai/generate';
import type { Logger } from '@ai-pipeline/observability/logger';
import { translateSegments } from './translate.js';
import type { TranscriptSegment } from './schemas.js';

/** `translateSegments`/`translateChunk` only ever call `ctx.run` and `ctx.date.now`. */
function fakeContext(): restate.Context {
  return {
    run: async (_name: string, fn: () => unknown) => fn(),
    date: { now: async () => Date.now() },
  } as unknown as restate.Context;
}

const noop = () => undefined;
const silentLog = { info: noop, debug: noop, warn: noop, error: noop } as unknown as Logger;

function segments(ids: number[]): TranscriptSegment[] {
  return ids.map((id) => ({ id, start: id, end: id + 1, text: `source ${id}` }));
}

function response(text: string, finishReason = 'stop'): GenerateResult {
  return { text, model: 'chat-default', usage: { outputTokens: 10 }, finishReason };
}

const toJson = (ids: number[]) =>
  JSON.stringify(ids.map((id) => ({ id, text: `translated ${id}` })));

describe('translateSegments', () => {
  it('translates every segment in one pass when the model responds completely', async () => {
    const generate = vi.fn<Generate>(async () => response(toJson([0, 1, 2])));
    const result = await translateSegments(
      fakeContext(),
      generate,
      silentLog,
      segments([0, 1, 2]),
      'fr',
      'chat-default',
      80,
      2,
    );
    expect(result.map((s) => s.text)).toEqual(['translated 0', 'translated 1', 'translated 2']);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries with a larger budget when the response is truncated, without splitting', async () => {
    const generate = vi
      .fn<Generate>()
      .mockResolvedValueOnce(response('[{"id":0,"text":"oops"', 'length')) // cut off mid-item
      .mockResolvedValueOnce(response(toJson([0, 1])));

    const result = await translateSegments(
      fakeContext(),
      generate,
      silentLog,
      segments([0, 1]),
      'ar',
      'chat-default',
      80,
      0,
    );
    expect(result.map((s) => s.text)).toEqual(['translated 0', 'translated 1']);
    expect(generate).toHaveBeenCalledTimes(2);
    // Second attempt gets a strictly larger budget than the first.
    const [first, second] = generate.mock.calls;
    expect(second![0].maxOutputTokens).toBeGreaterThan(first![0].maxOutputTokens!);
  });

  it('splits a chunk in half when every budget attempt stays incomplete', async () => {
    const generate = vi.fn<Generate>(async ({ prompt }) => {
      // Only ever respond completely once the request is for a single segment.
      const requested: { id: number }[] = JSON.parse(prompt.split('\n').at(-1)!);
      if (requested.length === 1) return response(toJson(requested.map((s) => s.id)));
      return response(toJson([requested[0]!.id])); // always "forgets" the second id
    });

    const result = await translateSegments(
      fakeContext(),
      generate,
      silentLog,
      segments([5, 6]),
      'pt',
      'chat-default',
      80,
      0,
    );
    expect(result.map((s) => s.text)).toEqual(['translated 5', 'translated 6']);
    // 3 failed attempts on the pair + 1 success per single-segment half.
    expect(generate).toHaveBeenCalledTimes(3 + 1 + 1);
  });

  it('fails the run if a single segment never completes', async () => {
    const generate = vi.fn<Generate>(async () => response('not json at all'));
    await expect(
      translateSegments(fakeContext(), generate, silentLog, segments([9]), 'ar', 'chat-default', 80, 0),
    ).rejects.toThrow(restate.TerminalError);
  });
});
