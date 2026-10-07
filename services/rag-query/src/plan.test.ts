import { rerankWithScorer } from '@mastra/rag';
import * as restate from '@restatedev/restate-sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  applyRerank,
  exactWeights,
  planRetrieval,
  type RetrievalRequest,
} from './plan.js';
import type { Hit, RagQueryConfig } from './schemas.js';

const config: RagQueryConfig = {
  answerModel: 'chat-answer',
  rerankModel: 'chat-rerank',
  defaults: { topK: 5 },
  limits: { maxTopK: 50, maxCandidates: 20, maxContextChars: 12_000, maxOutputTokens: 2048 },
};
const request: RetrievalRequest = { collection: 'docs', query: 'how do roots drink?' };

/** The 400 a plan refuses with, or undefined. */
function refusal(fn: () => unknown): restate.TerminalError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(restate.TerminalError);
    expect((error as restate.TerminalError).code).toBe(400);
    return error as restate.TerminalError;
  }
}

describe('planRetrieval', () => {
  it('fills in the defaults from config', () => {
    expect(planRetrieval(request, config)).toEqual({
      collection: 'docs',
      query: 'how do roots drink?',
      fetch: 5,
      topK: 5,
      includeVector: false,
    });
  });

  it('passes the search knobs through, and drops an empty filter', () => {
    expect(
      planRetrieval(
        { ...request, topK: 7, filter: {}, minScore: 0.25, includeVector: true, ef: 80, probes: 3 },
        config,
      ),
    ).toEqual({
      collection: 'docs',
      query: 'how do roots drink?',
      fetch: 7,
      topK: 7,
      minScore: 0.25,
      includeVector: true,
      ef: 80,
      probes: 3,
    });
  });

  it("holds a request to this deployment's limits", () => {
    const tight = { ...config, limits: { ...config.limits, maxTopK: 10, maxCandidates: 8 } };
    expect(refusal(() => planRetrieval({ ...request, topK: 11 }, tight))?.message).toBe(
      'invalid request: topK is at most 10',
    );
    expect(
      refusal(() => planRetrieval({ ...request, rerank: { candidates: 9 } }, tight))?.message,
    ).toBe('invalid request: rerank.candidates is at most 8');
    expect(refusal(() => planRetrieval({ ...request, topK: 9, rerank: {} }, tight))?.message).toBe(
      'invalid request: topK is at most 8 when reranking',
    );
  });

  it('refuses a filter outside the whitelist, naming each problem', () => {
    const error = refusal(() =>
      planRetrieval({ ...request, filter: { title: { $regex: 'x' }, 'a-b': 1 } }, config),
    );
    expect(error?.message).toMatch(/^invalid request: filter\.title\.\$regex: .*; filter\.a-b: /);
  });

  it('reports problems found elsewhere in the request in the same 400', () => {
    const error = refusal(() =>
      planRetrieval({ ...request, topK: 51 }, config, ['maxContextChars is at most 12000']),
    );
    expect(error?.message).toBe(
      'invalid request: maxContextChars is at most 12000; topK is at most 50',
    );
  });

  describe('with a rerank', () => {
    it('fetches three candidates per hit kept, within the limit, and scores with config’s model', () => {
      expect(planRetrieval({ ...request, rerank: {} }, config)).toMatchObject({
        fetch: 15,
        topK: 5,
        rerank: { model: 'chat-rerank', requested: false, weights: DEFAULT_WEIGHTS },
      });
      expect(planRetrieval({ ...request, topK: 10, rerank: {} }, config)).toMatchObject({
        fetch: 20,
        topK: 10,
      });
    });

    it('keeps rerank.topK hits from rerank.candidates, scored by the model asked for', () => {
      expect(
        planRetrieval(
          { ...request, topK: 3, rerank: { candidates: 12, topK: 4, model: 'chat-big' } },
          config,
        ),
      ).toMatchObject({
        fetch: 12,
        topK: 4,
        rerank: { model: 'chat-big', requested: true },
      });
    });

    it('needs at least as many candidates as hits kept', () => {
      expect(
        refusal(() => planRetrieval({ ...request, rerank: { candidates: 3, topK: 4 } }, config))
          ?.message,
      ).toBe('invalid request: rerank.candidates (3) must be at least the hits kept (4)');
    });

    it('needs weights that sum to 1', () => {
      expect(
        refusal(() =>
          planRetrieval(
            { ...request, rerank: { weights: { semantic: 0.5, vector: 0.5, position: 0.5 } } },
            config,
          ),
        )?.message,
      ).toBe('invalid request: rerank.weights must sum to 1, not 1.5');
      const thirds = { semantic: 1 / 3, vector: 1 / 3, position: 1 / 3 };
      expect(planRetrieval({ ...request, rerank: { weights: thirds } }, config).rerank).toEqual({
        model: 'chat-rerank',
        requested: false,
        weights: { semantic: 0.333334, vector: 0.333333, position: 0.333333 },
      });
    });
  });
});

describe('exactWeights', () => {
  const millionths = (weights: Record<string, number>) =>
    Object.values(weights).map((w) => Math.round(w * 1_000_000));

  it('leaves weights that are already exact alone', () => {
    expect(exactWeights(DEFAULT_WEIGHTS)).toEqual(DEFAULT_WEIGHTS);
    expect(exactWeights({ semantic: 0.1, vector: 0.7, position: 0.2 })).toEqual({
      semantic: 0.1,
      vector: 0.7,
      position: 0.2,
    });
  });

  it('snaps near misses to millionths that sum to exactly one million', () => {
    for (const weights of [
      { semantic: 1 / 3, vector: 1 / 3, position: 1 / 3 },
      { semantic: 0.1 + 0.2, vector: 0.3, position: 0.4 },
      { semantic: 0.6666667, vector: 0.3333333, position: 0 },
    ]) {
      const exact = exactWeights(weights);
      const units = millionths(exact);
      expect(units.reduce((a, b) => a + b, 0)).toBe(1_000_000);
      for (const [key, value] of Object.entries(exact)) {
        // What big.js reads: the printed decimal, which must be the exact millionth.
        expect(String(value)).toMatch(/^(0|1)(\.\d{1,6})?$/);
        expect(Math.abs(value - weights[key as keyof typeof weights])).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("passes Mastra's own exact-sum check, which raw thirds fail", async () => {
    const results = [{ id: 'a', score: 0.5, metadata: { text: 'a' } }];
    const scorer = { getRelevanceScore: async () => 0.5 };
    const thirds = { semantic: 1 / 3, vector: 1 / 3, position: 1 / 3 };
    await expect(
      rerankWithScorer({ results, query: 'q', scorer, options: { weights: thirds, topK: 1 } }),
    ).rejects.toThrow(/Weights must add up to 1/);
    await expect(
      rerankWithScorer({
        results,
        query: 'q',
        scorer,
        options: { weights: exactWeights(thirds), topK: 1 },
      }),
    ).resolves.toHaveLength(1);
  });
});

describe('applyRerank', () => {
  const hit = (id: string): Hit => ({
    id,
    score: 0.5,
    documentId: `doc-${id}`,
    chunkIndex: 0,
    text: id,
    metadata: {},
  });

  it('orders the hits as ranked and attaches their scores', () => {
    const ranked = [
      { id: 'b', score: 0.9, semantic: 1, vector: 0.5, position: 0.5 },
      { id: 'a', score: 0.4, semantic: 0, vector: 0.5, position: 1 },
      { id: 'gone', score: 0.1, semantic: 0, vector: 0, position: 0 },
    ];
    expect(applyRerank([hit('a'), hit('b'), hit('c')], ranked)).toEqual([
      { ...hit('b'), rerank: { score: 0.9, semantic: 1, vector: 0.5, position: 0.5 } },
      { ...hit('a'), rerank: { score: 0.4, semantic: 0, vector: 0.5, position: 1 } },
    ]);
  });
});
