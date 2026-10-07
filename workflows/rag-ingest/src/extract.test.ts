import type { LanguageModel } from '@ai-pipeline/ai/language-model';
import { describe, expect, it } from 'vitest';
import type { Chunk } from './chunk.js';
import { extractMetadata, type RunExtractors } from './extract.js';
import type { ExtractPlan } from './plan.js';

/**
 * The batching around Mastra's extractors, with Mastra itself stubbed: what goes to it per call,
 * and how the results are put back together.
 */

const chunks = (n: number): Chunk[] =>
  Array.from({ length: n }, (_, i) => ({ text: `chunk ${i}`, metadata: { chunkNo: i } }));
const model = {} as LanguageModel;

/** A stand-in for Mastra: records each call and answers deterministically from the chunk text. */
function fakeMastra() {
  const calls: { size: number; params: string[] }[] = [];
  const run: RunExtractors = async (batch, params) => {
    calls.push({ size: batch.length, params: Object.keys(params ?? {}).sort() });
    return batch.map((chunk) => ({
      ...chunk.metadata,
      ...(params?.title ? { documentTitle: 'The Title' } : {}),
      ...(params?.summary ? { sectionSummary: `summary of ${chunk.text}` } : {}),
      ...(params?.keywords ? { excerptKeywords: `kw ${chunk.text}` } : {}),
      // Something the extractors must not be able to overwrite:
      chunkNo: -1,
    }));
  };
  return { run, calls };
}

const plan = (overrides: Partial<ExtractPlan>): ExtractPlan => ({
  model: 'chat',
  batchSize: 2,
  ...overrides,
});

describe('extractMetadata', () => {
  it('sends batches of batchSize, one after another — the bound on calls in flight', async () => {
    const { run, calls } = fakeMastra();
    const result = await extractMetadata(
      chunks(5),
      plan({ keywords: { keywords: 3 } }),
      model,
      'd',
      run,
    );
    expect(calls.map((c) => c.size)).toEqual([2, 2, 1]);
    expect(result.map((c) => c.metadata.excerptKeywords)).toEqual([
      'kw chunk 0',
      'kw chunk 1',
      'kw chunk 2',
      'kw chunk 3',
      'kw chunk 4',
    ]);
    // Only extracted keys come back; the chunk's own metadata stays.
    expect(result.map((c) => c.metadata.chunkNo)).toEqual([0, 1, 2, 3, 4]);
  });

  it('infers the title once, from the first nodes, and gives it to every chunk', async () => {
    const { run, calls } = fakeMastra();
    const result = await extractMetadata(chunks(5), plan({ title: { nodes: 3 } }), model, 'd', run);
    expect(calls).toEqual([{ size: 3, params: ['title'] }]);
    expect(new Set(result.map((c) => c.metadata.documentTitle))).toEqual(new Set(['The Title']));
  });

  it('fills prev and next summaries across batch boundaries, and keeps self only if asked', async () => {
    const { run } = fakeMastra();
    const result = await extractMetadata(
      chunks(3),
      plan({ summary: { summaries: ['prev', 'next'] } }),
      model,
      'd',
      run,
    );
    expect(result.map((c) => c.metadata.prevSectionSummary)).toEqual([
      undefined,
      'summary of chunk 0',
      'summary of chunk 1',
    ]);
    expect(result.map((c) => c.metadata.nextSectionSummary)).toEqual([
      'summary of chunk 1',
      'summary of chunk 2',
      undefined,
    ]);
    expect(result.every((c) => !('sectionSummary' in c.metadata))).toBe(true);
  });

  it('runs every per-chunk extractor in the same batch call', async () => {
    const { run, calls } = fakeMastra();
    await extractMetadata(
      chunks(2),
      plan({
        summary: { summaries: ['self'] },
        keywords: { keywords: 5 },
        questions: { questions: 2 },
      }),
      model,
      'd',
      run,
    );
    expect(calls).toEqual([{ size: 2, params: ['keywords', 'questions', 'summary'] }]);
  });
});
