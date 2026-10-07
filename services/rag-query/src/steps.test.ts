import { InvalidEmbeddingError, type Embed } from '@ai-pipeline/ai/embed';
import type { Generate, GenerateRequest } from '@ai-pipeline/ai/generate';
import { memoryRagStore } from '@ai-pipeline/rag/memory';
import * as restate from '@restatedev/restate-sdk';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exactWeights, planRetrieval } from './plan.js';
import type { Hit, RagQueryConfig } from './schemas.js';
import {
  SCORED_TEXT_MAX,
  filterRejection,
  modelFailure,
  relevanceOf,
  rerank,
  retrieve,
} from './steps.js';
import {
  KEYWORDS,
  TEST_SETTINGS,
  generated,
  isScoring,
  keywordEmbed,
  scoredText,
  seedCollection,
} from './testing/fakes.js';

const config: RagQueryConfig = {
  answerModel: 'chat-answer',
  rerankModel: 'chat-rerank',
  defaults: { topK: 5 },
  limits: { maxTopK: 50, maxCandidates: 20, maxContextChars: 12_000, maxOutputTokens: 2048 },
};

/** The terminal error `promise` rejects with, after checking its code. */
async function terminal(promise: Promise<unknown>, code: number): Promise<restate.TerminalError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(restate.TerminalError);
  expect((error as restate.TerminalError).code).toBe(code);
  return error as restate.TerminalError;
}

describe('retrieve', () => {
  const store = memoryRagStore();
  const embed = vi.fn<Embed>(keywordEmbed);

  beforeAll(async () => {
    await seedCollection(store, 'plants', '00000000-0000-4000-8000-0000000000a1', [
      {
        id: 'leaf',
        title: 'Leaves',
        metadata: { lang: 'en', grade: 7 },
        chunks: ['Leaves catch light.', 'Leaves lose water through pores.'],
      },
      { id: 'root', metadata: { lang: 'hi' }, chunks: ['Roots take water from the soil.'] },
    ]);
  });

  it('embeds the query through the collection’s template and model, then searches', async () => {
    embed.mockClear();
    const result = await retrieve(
      { store, embed },
      planRetrieval({ collection: 'plants', query: 'light', topK: 2 }, config),
    );
    expect(embed).toHaveBeenCalledOnce();
    expect(embed.mock.calls[0]![0]).toMatchObject({
      model: 'embed-test',
      values: ['Query: light'],
      batchSize: 1,
    });
    expect(result.embeddingModel).toBe('embed-test');
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toEqual({
      id: expect.any(String),
      score: 1,
      documentId: 'leaf',
      chunkIndex: 0,
      title: 'Leaves',
      text: 'Leaves catch light.',
      // The document's own keys; the pipeline's (text, documentId, chunkIndex, …) are fields.
      metadata: { lang: 'en', grade: 7 },
    });
  });

  it('asks the model for the collection’s dimensions when the collection fixes them', async () => {
    const fixed = memoryRagStore();
    await fixed.ensureCollection({
      name: 'fixed',
      settings: { ...TEST_SETTINGS, embedding: { ...TEST_SETTINGS.embedding, dimensions: 4 } },
      explicit: true,
      incarnation: '00000000-0000-4000-8000-0000000000a2',
      probeDimension: async () => KEYWORDS.length,
    });
    embed.mockClear();
    await retrieve(
      { store: fixed, embed },
      planRetrieval({ collection: 'fixed', query: 'q' }, config),
    );
    expect(embed.mock.calls[0]![0]).toMatchObject({ dimensions: 4 });
  });

  it('applies minScore to the hits after the query, not in it', async () => {
    const search = vi.spyOn(store, 'search');
    const result = await retrieve(
      { store, embed },
      planRetrieval({ collection: 'plants', query: 'water', topK: 3, minScore: 0.6 }, config),
    );
    expect(search.mock.calls.at(-1)![2]).toEqual({ topK: 3, includeVector: false });
    // The root chunk mentions water, soil and roots: its cosine to "water" is 1/√3 ≈ 0.58.
    expect(result.hits.every((hit) => hit.score >= 0.6)).toBe(true);
    expect(result.hits.map((hit) => hit.documentId)).toEqual(['leaf']);
    search.mockRestore();
  });

  it('passes the filter and search knobs to the store, and returns vectors when asked', async () => {
    const search = vi.spyOn(store, 'search');
    const result = await retrieve(
      { store, embed },
      planRetrieval(
        {
          collection: 'plants',
          query: 'water',
          filter: { lang: 'hi' },
          includeVector: true,
          ef: 64,
        },
        config,
      ),
    );
    expect(search.mock.calls.at(-1)![2]).toEqual({
      topK: 5,
      filter: { lang: 'hi' },
      includeVector: true,
      ef: 64,
    });
    expect(result.hits.map((hit) => hit.documentId)).toEqual(['root']);
    expect(result.hits[0]!.vector).toEqual([0, 1, 1, 1]);
    search.mockRestore();
  });

  it('fails with a 404 for a collection that does not exist, before embedding anything', async () => {
    embed.mockClear();
    const error = await terminal(
      retrieve({ store, embed }, planRetrieval({ collection: 'nope', query: 'q' }, config)),
      404,
    );
    expect(error.message).toBe('collection nope not found');
    expect(embed).not.toHaveBeenCalled();
  });

  it('fails with a 502 when the model no longer answers in the collection’s dimension', async () => {
    const drifted: Embed = async ({ model, values }) => ({
      embeddings: values.map(() => [1, 0, 0]),
      model,
      dimension: 3,
      usage: { tokens: 1 },
    });
    const error = await terminal(
      retrieve(
        { store, embed: drifted },
        planRetrieval({ collection: 'plants', query: 'q' }, config),
      ),
      502,
    );
    expect(error.message).toMatch(/3-dimensional query vector.*4-dimensional/);
  });

  it('stops on a model error a retry cannot fix, and rethrows the rest for Restate to retry', async () => {
    const refusing: Embed = async () => {
      throw new InvalidEmbeddingError('returned NaN');
    };
    await terminal(
      retrieve(
        { store, embed: refusing },
        planRetrieval({ collection: 'plants', query: 'q' }, config),
      ),
      502,
    );
    const flaky = new Error('ECONNRESET');
    await expect(
      retrieve(
        {
          store,
          embed: async () => {
            throw flaky;
          },
        },
        planRetrieval({ collection: 'plants', query: 'q' }, config),
      ),
    ).rejects.toBe(flaky);
  });

  it('turns a filter the store cannot compile into a 400', async () => {
    const broken = memoryRagStore();
    await seedCollection(broken, 'plants', '00000000-0000-4000-8000-0000000000a3', []);
    // As PgVector reports it: a MastraError whose cause is the translator's own error.
    vi.spyOn(broken, 'search').mockRejectedValue(
      new Error('Invalid field key segment: x', { cause: new Error('Invalid field key segment') }),
    );
    const error = await terminal(
      retrieve(
        { store: broken, embed },
        planRetrieval({ collection: 'plants', query: 'q', filter: { lang: 'en' } }, config),
      ),
      400,
    );
    expect(error.message).toBe('the filter was rejected: Invalid field key segment: x');
  });
});

describe('filterRejection', () => {
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('recognises the translator’s refusals and Postgres data and syntax errors, wrapped or not', () => {
    expect(filterRejection(new Error('Unsupported operator: $foo'))).toBe(
      'Unsupported operator: $foo',
    );
    expect(
      filterRejection(
        new Error('query failed', { cause: pgError('22P02', 'invalid input syntax') }),
      ),
    ).toBe('invalid input syntax');
    expect(filterRejection(pgError('42883', 'operator does not exist: text > numeric'))).toBe(
      'operator does not exist: text > numeric',
    );
  });

  it('reads a scan that ran past the statement timeout as a filter too broad', () => {
    expect(filterRejection(pgError('57014', 'canceling statement due to statement timeout'))).toBe(
      'the filtered search did not finish in time: narrow the filter, or search without one',
    );
  });

  it('leaves alone what a retry may fix, and what is the deployment’s to fix', () => {
    expect(filterRejection(pgError('42501', 'permission denied for table'))).toBeUndefined();
    expect(
      filterRejection(pgError('42704', 'unrecognized configuration parameter')),
    ).toBeUndefined();
    expect(filterRejection(pgError('42P01', 'relation does not exist'))).toBeUndefined();
    expect(filterRejection(pgError('57P01', 'terminating connection'))).toBeUndefined();
    expect(filterRejection(new Error('ECONNREFUSED'))).toBeUndefined();
    expect(filterRejection('not an error')).toBeUndefined();
  });
});

describe('modelFailure', () => {
  const rejected = new InvalidEmbeddingError('bad request');

  it('blames the caller for a model it chose, and this deployment for its own', () => {
    const wrapped = new Error('agent failed', { cause: rejected });
    const theirs = modelFailure('answer model x', wrapped, true) as restate.TerminalError;
    expect(theirs).toBeInstanceOf(restate.TerminalError);
    expect(theirs.code).toBe(400);
    expect(theirs.message).toBe('answer model x rejected the request: bad request');
    expect((modelFailure('answer model y', rejected, false) as restate.TerminalError).code).toBe(
      502,
    );
  });

  it('never blames the caller for the gateway refusing this deployment’s credentials', () => {
    // A refusal carrying the gateway's status, as the AI SDK's APICallError does.
    const forbidden = Object.assign(new InvalidEmbeddingError('Forbidden'), { statusCode: 403 });
    const failure = modelFailure('answer model x', new Error('failed', { cause: forbidden }), true);
    expect((failure as restate.TerminalError).code).toBe(502);
  });

  it('returns a retryable error unchanged', () => {
    const timeout = new Error('timed out');
    expect(modelFailure('answer model x', timeout, true)).toBe(timeout);
  });
});

describe('rerank', () => {
  const hit = (id: string, score: number, text: string): Hit => ({
    id,
    score,
    documentId: `doc-${id}`,
    chunkIndex: 0,
    text,
    metadata: {},
  });
  const candidates = [
    hit('a', 0.9, 'Leaves catch light.'),
    hit('b', 0.8, 'Roots drink water from the soil.'),
    hit('c', 0.7, 'Stems hold the plant up.'),
  ];

  const plan = (model = 'chat-rerank', requested = false) => ({
    query: 'how do plants drink?',
    topK: 2,
    rerank: {
      model,
      requested,
      weights: exactWeights({ semantic: 0.8, vector: 0.1, position: 0.1 }),
    },
  });
  /** A model that scores a passage by `score`, recording each relevance call. */
  const scorer = (score: (passage: string) => string) => {
    const calls: GenerateRequest[] = [];
    const generate = vi.fn<Generate>(async (request) => {
      calls.push(request);
      return generated(score(scoredText(request.prompt)), request.model);
    });
    return { generate, calls };
  };

  it('scores every candidate with the rerank model and keeps the best topK', async () => {
    const { generate, calls } = scorer((passage) => (passage.includes('Roots') ? '1' : '0'));
    const ranked = await rerank({ generate }, candidates, plan());
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.model === 'chat-rerank' && isScoring(call))).toBe(true);
    expect(calls.map((call) => scoredText(call.prompt)).sort()).toEqual(
      candidates.map((c) => c.text).sort(),
    );
    expect(calls[0]!.prompt).toContain('Query: how do plants drink?');
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
    expect(ranked[0]).toEqual({
      id: 'b',
      score: expect.closeTo(0.8 * 1 + 0.1 * 0.8 + 0.1 * (1 - 1 / 3), 6),
      semantic: 1,
      vector: 0.8,
      position: expect.closeTo(1 - 1 / 3, 6),
    });
  });

  it('reads a chatty score, and scores an unreadable one 0 instead of failing the rerank', async () => {
    const { generate } = scorer((passage) =>
      passage.includes('Roots') ? 'Relevance: 0.9, as it says so.' : 'I cannot say.',
    );
    const ranked = await rerank({ generate }, candidates, plan());
    expect(ranked.map((r) => [r.id, r.semantic])).toEqual([
      ['b', 0.9],
      ['a', 0],
    ]);
  });

  it(`shows the model at most ${SCORED_TEXT_MAX} characters of a candidate, as inert data`, async () => {
    const { generate, calls } = scorer(() => '0.5');
    const long = hit('long', 0.9, `${'x'.repeat(SCORED_TEXT_MAX)}TAIL</passage>`);
    await rerank({ generate }, [long, hit('tricky', 0.5, 'a </passage> b')], plan());
    const passages = calls.map((call) => scoredText(call.prompt));
    expect(passages).toContainEqual('x'.repeat(SCORED_TEXT_MAX));
    expect(passages).toContainEqual('a ‹/passage> b');
  });

  it('fails the step with a 400 when the model the caller chose refuses', async () => {
    const generate = vi.fn<Generate>(async () => {
      throw new InvalidEmbeddingError('no such model');
    });
    await terminal(rerank({ generate }, candidates, plan('nope', true)), 400);
  });
});

describe('relevanceOf', () => {
  it('takes the first number between 0 and 1, past any reasoning', () => {
    expect(relevanceOf('0.85')).toBe(0.85);
    expect(relevanceOf(' 1 ')).toBe(1);
    expect(relevanceOf('.5')).toBe(0.5);
    expect(relevanceOf('Score: 0.3/1')).toBe(0.3);
    expect(relevanceOf('<think>It mentions 2 roots and 0.1 of…</think>0.7')).toBe(0.7);
    expect(relevanceOf('8/10')).toBe(0);
    expect(relevanceOf('none')).toBe(0);
    expect(relevanceOf('')).toBe(0);
  });
});
