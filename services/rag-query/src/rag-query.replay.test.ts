import type { Embed } from '@ai-pipeline/ai/embed';
import type { Generate } from '@ai-pipeline/ai/generate';
import { memoryRagStore } from '@ai-pipeline/rag/memory';
import type { RagStore } from '@ai-pipeline/rag/store';
import * as clients from '@restatedev/restate-sdk-clients';
import { RestateContainer, RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_HITS_ANSWER } from './answer.js';
import { ragQueryApi } from './api.js';
import { createRagQueryService } from './service.js';
import {
  TEST_SETTINGS,
  generated,
  isScoring,
  keywordEmbed,
  scoredText,
  seedCollection,
} from './testing/fakes.js';

type Fn = (...args: unknown[]) => Promise<unknown>;

/**
 * Runs the real handlers against a Restate server with always-replay on, so any non-determinism
 * fails here instead of on a production retry.
 *
 * The point is the pair of counters: each handler body runs several times (it suspends after every
 * journaled step and replays), while each step (the retrieval, the rerank, the model call) runs
 * exactly once.
 */
describe('RagQuery (always replay)', () => {
  const memory = memoryRagStore();
  // The next `stale` chunk reads return another version's chunks, as a re-ingest landing between
  // a document's two reads would.
  const reads = { stale: 0, chunks: 0 };
  const store: RagStore = {
    ...memory,
    async documentChunks(ref, documentId) {
      reads.chunks++;
      const chunks = await memory.documentChunks(ref, documentId);
      if (reads.stale === 0) return chunks;
      reads.stale--;
      return chunks.map((c) => ({ ...c, metadata: { ...c.metadata, fingerprint: 'fp:older' } }));
    },
  };
  const embed = vi.fn<Embed>(keywordEmbed);
  // The reranker's relevance calls rate a candidate relevant when it mentions soil; every other
  // call is an answer.
  const generate = vi.fn<Generate>(async (request) =>
    isScoring(request)
      ? generated(scoredText(request.prompt).includes('soil') ? '1' : '0', request.model)
      : {
          ...generated('Chlorophyll in the leaves absorbs light [S1].', request.model),
          // A question asking for detail runs the model out of output tokens.
          ...(request.prompt.includes('in detail') ? { finishReason: 'length' as const } : {}),
        },
  );
  /** The answer calls, apart from the reranker's relevance calls. */
  const answers = () =>
    generate.mock.calls.map(([request]) => request).filter((r) => !isScoring(r));
  const ragQuery = createRagQueryService({ store, embed, generate });
  const executions: Record<string, number> = {};

  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  const rag = () => ingress.client(ragQueryApi);

  beforeAll(async () => {
    await seedCollection(store, 'plants', '00000000-0000-4000-8000-0000000000b1', [
      {
        id: 'leaf',
        title: 'Leaves',
        metadata: { lang: 'en' },
        chunks: ['Chlorophyll in the leaves absorbs light.', 'Leaves lose water through pores.'],
      },
      { id: 'root', metadata: { lang: 'en' }, chunks: ['Roots take water from the soil.'] },
    ]);

    // Service-level options override server defaults, so always-replay must be forced here:
    // suspend at every await (replay), and fail fast on a journal mismatch.
    const definition = ragQuery as unknown as {
      options?: object;
      service: Record<string, Record<symbol, unknown>>;
    };
    definition.options = {
      ...definition.options,
      inactivityTimeout: 0,
      retryPolicy: { maxAttempts: 3, onMaxAttempts: 'kill' },
    };
    // Count executions of each handler body, to prove it really replays.
    // (The SDK keeps the function on the HandlerWrapper behind Symbol(Handler).)
    for (const [name, route] of Object.entries(definition.service)) {
      const symbol = Object.getOwnPropertySymbols(route).find((s) => s.description === 'Handler');
      const wrapper = route[symbol!] as { handler: Fn };
      const body = wrapper.handler;
      wrapper.handler = (...args) => {
        executions[name] = (executions[name] ?? 0) + 1;
        return body(...args);
      };
    }
    env = await RestateTestEnvironment.start({ services: [ragQuery] }, () =>
      new RestateContainer('1.7.10').alwaysReplay(),
    );
    ingress = clients.connect({ url: env.baseUrl() });
  });

  afterAll(async () => env?.stop());

  beforeEach(() => {
    embed.mockClear();
    generate.mockClear();
    for (const name of Object.keys(executions)) delete executions[name];
  });

  it('searches: one retrieval, however often the body replays', async () => {
    const result = await rag().search({ collection: 'plants', query: 'light', topK: 1 });
    expect(result).toEqual({
      collection: 'plants',
      embeddingModel: 'embed-test',
      reranked: false,
      hits: [
        {
          id: expect.any(String),
          score: 1,
          documentId: 'leaf',
          chunkIndex: 0,
          title: 'Leaves',
          text: 'Chlorophyll in the leaves absorbs light.',
          metadata: { lang: 'en' },
        },
      ],
    });
    expect(executions.search).toBeGreaterThan(1);
    expect(embed).toHaveBeenCalledOnce();
    expect(embed.mock.calls[0]![0]).toMatchObject({
      model: 'embed-test',
      values: ['Query: light'],
    });
  });

  it('reranks with one scoring call per candidate, journaled once', async () => {
    const result = await rag().search({
      collection: 'plants',
      query: 'water',
      topK: 1,
      rerank: { candidates: 3, weights: { semantic: 0.8, vector: 0.1, position: 0.1 } },
    });
    // By the vector alone, "Leaves lose water…" is closest; the reranker prefers the soil.
    expect(result.reranked).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      documentId: 'root',
      text: 'Roots take water from the soil.',
      rerank: { semantic: 1, position: expect.closeTo(2 / 3, 6) },
    });
    expect(result.hits[0]!.rerank!.score).toBeGreaterThan(0.9);
    expect(executions.search).toBeGreaterThan(2);
    expect(embed).toHaveBeenCalledOnce();
    const scoring = generate.mock.calls.map(([request]) => request).filter(isScoring);
    expect(scoring).toHaveLength(3);
    expect(scoring.every((call) => call.model === 'chat-default')).toBe(true);
    expect(answers()).toEqual([]);
  });

  it('answers from the evidence with one model call, citing the source it used', async () => {
    const answer = await rag().answer({ collection: 'plants', question: 'What absorbs light?' });
    expect(answer).toEqual({
      collection: 'plants',
      status: 'answered',
      answer: 'Chlorophyll in the leaves absorbs light [S1].',
      citations: [{ id: 'S1', documentId: 'leaf', chunkIndex: 0, title: 'Leaves', score: 1 }],
      model: 'chat-default',
    });
    expect(executions.answer).toBeGreaterThan(2);
    expect(embed).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    const call = answers()[0]!;
    expect(call).toMatchObject({ model: 'chat-default', maxOutputTokens: 1024 });
    expect(call.system).toMatch(/untrusted data/);
    expect(call.prompt).toContain('[S1] Leaves\nChlorophyll in the leaves absorbs light.');
    expect(call.prompt).toMatch(/Question: What absorbs light\?$/);
  });

  it('says when the model ran out of output tokens', async () => {
    const answer = await rag().answer({
      collection: 'plants',
      question: 'What absorbs light, in detail?',
    });
    expect(answer).toMatchObject({ status: 'answered', truncated: true });
  });

  it('says there is no evidence, without a model call, when nothing matches', async () => {
    const answer = await rag().answer({
      collection: 'plants',
      question: 'What absorbs light?',
      filter: { lang: 'fr' },
    });
    expect(answer).toEqual({
      collection: 'plants',
      status: 'insufficient_evidence',
      answer: NO_HITS_ANSWER,
      citations: [],
      model: 'chat-default',
    });
    expect(embed).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails a search of an unknown collection with a 404', async () => {
    const error = await rag()
      .search({ collection: 'nope', query: 'light' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(clients.HttpCallError);
    expect((error as clients.HttpCallError).status).toBe(404);
    expect((error as clients.HttpCallError).message).toMatch(/collection nope not found/);
    expect(embed).not.toHaveBeenCalled();
    await expect(rag().answer({ collection: 'nope', question: 'q' })).rejects.toMatchObject({
      status: 404,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('refuses a request it cannot serve with a 400, before any I/O', async () => {
    await expect(
      rag().search({ collection: 'plants', query: 'q', filter: { text: { $regex: '.*' } } }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/\$regex is not allowed/),
    });
    await expect(
      rag().search({
        collection: 'plants',
        query: 'q',
        rerank: { weights: { semantic: 0.5, vector: 0.5, position: 0.5 } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      rag().answer({ collection: 'plants', question: 'q', maxContextChars: 20_000 }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/maxContextChars is at most 12000/),
    });
    // The question and instructions count against the budget: this one leaves too little.
    await expect(
      rag().answer({ collection: 'plants', question: 'q'.repeat(600), maxContextChars: 1000 }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/leaves less than 500 characters of evidence/),
    });
    await expect(
      rag().answer({ collection: 'plants', question: 'q', maxOutputTokens: 4096 }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/maxOutputTokens is at most 2048/),
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('lists and describes collections, without their internal ids', async () => {
    const { collections } = await rag().listCollections({});
    expect(collections.map((c) => c.name)).toEqual(['plants']);
    const plants = await rag().getCollection({ collection: 'plants' });
    expect(plants).toEqual({
      name: 'plants',
      embeddingModel: 'embed-test',
      dimension: 4,
      settings: TEST_SETTINGS,
      documents: 2,
      chunks: 3,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await expect(rag().getCollection({ collection: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('pages through documents, and returns one with its chunks in order', async () => {
    const first = await rag().listDocuments({ collection: 'plants', limit: 1 });
    expect(first.documents.map((d) => d.documentId)).toEqual(['leaf']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await rag().listDocuments({
      collection: 'plants',
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.documents.map((d) => d.documentId)).toEqual(['root']);
    expect(second.nextCursor).toBeUndefined();

    const leaf = await rag().getDocument({
      collection: 'plants',
      documentId: 'leaf',
      chunks: true,
    });
    expect(leaf).toEqual({
      documentId: 'leaf',
      title: 'Leaves',
      format: 'text',
      metadata: { lang: 'en' },
      chunkCount: 2,
      fingerprint: 'fp:leaf',
      seq: 1,
      runId: 'seed',
      updatedAt: expect.any(String),
      chunks: [
        {
          id: expect.any(String),
          chunkIndex: 0,
          text: 'Chlorophyll in the leaves absorbs light.',
          metadata: { lang: 'en' },
        },
        {
          id: expect.any(String),
          chunkIndex: 1,
          text: 'Leaves lose water through pores.',
          metadata: { lang: 'en' },
        },
      ],
    });
    // A re-ingest between the ledger read and the chunk read: the pair is read again.
    reads.stale = 1;
    reads.chunks = 0;
    const reread = await rag().getDocument({
      collection: 'plants',
      documentId: 'leaf',
      chunks: true,
    });
    expect(reread).toEqual(leaf);
    expect(reads.chunks).toBe(2);

    const root = await rag().getDocument({ collection: 'plants', documentId: 'root' });
    expect(root).not.toHaveProperty('chunks');
    expect(root).not.toHaveProperty('title');
    await expect(
      rag().getDocument({ collection: 'plants', documentId: 'missing' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(rag().listDocuments({ collection: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
  });
});
