import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { controlPlanePlugin } from '../plugins/control-plane.js';
import { errorsPlugin } from '../plugins/errors.js';
import { ServiceCallError } from '../restate/ingress.js';
import {
  definitionOf,
  deploymentOf,
  fakeControlPlane,
  metadataOf,
  triggerOf,
} from '../testing/restate.js';
import { ragRoutes } from './rag.js';

/**
 * The RAG routes over their rules: which handler each path reaches, with which request, what is
 * refused before anything is called, and what reaches the wire. The rules themselves are tested in
 * `domain/rag.test.ts`.
 */
function api(options: { deployed?: boolean } = {}) {
  const cp = fakeControlPlane({
    seed: {
      definitions: [
        ...(options.deployed === false
          ? []
          : [
              definitionOf({
                metadata: metadataOf({
                  name: 'rag-query',
                  restateName: 'RagQuery',
                  kind: 'service',
                }),
              }),
            ]),
        definitionOf({
          metadata: metadataOf({ name: 'rag-ingest', restateName: 'RagIngest' }),
          // Any object: the routes are under test here, not rag-ingest's schema.
          schemas: { input: { type: 'object' }, output: { type: 'object' }, config: {} },
          contractHash: `sha256:${'c'.repeat(64)}`,
        }),
      ],
      deployments: [
        deploymentOf({ deploymentId: 'dp_q', name: 'rag-query', status: 'active' }),
        deploymentOf({ deploymentId: 'dp_i', name: 'rag-ingest', status: 'active' }),
      ],
      triggers: [triggerOf({ name: 'rag-ingest' })],
    },
  });
  const app = Fastify();
  void app.register(errorsPlugin);
  void app.register(controlPlanePlugin, cp);
  void app.register(ragRoutes, { prefix: '/v1', queryMs: 1_000, answerMs: 9_000 });
  return { app, cp };
}

describe('reads', () => {
  it.each([
    ['GET', '/v1/rag/collections', undefined, 'listCollections', {}],
    ['GET', '/v1/rag/collections/docs', undefined, 'getCollection', { collection: 'docs' }],
    [
      'GET',
      '/v1/rag/collections/docs/documents',
      undefined,
      'listDocuments',
      { collection: 'docs' },
    ],
    [
      'GET',
      '/v1/rag/collections/docs/documents?limit=20&cursor=abc',
      undefined,
      'listDocuments',
      { collection: 'docs', limit: 20, cursor: 'abc' },
    ],
    [
      'GET',
      '/v1/rag/collections/docs/documents/guides%2Fintro.md',
      undefined,
      'getDocument',
      { collection: 'docs', documentId: 'guides/intro.md' },
    ],
    [
      'GET',
      '/v1/rag/collections/docs/documents/a?chunks=true',
      undefined,
      'getDocument',
      { collection: 'docs', documentId: 'a', chunks: true },
    ],
    [
      'POST',
      '/v1/rag/collections/docs/search',
      { query: 'restate', topK: 3, collection: 'elsewhere' },
      'search',
      { query: 'restate', topK: 3, collection: 'docs' },
    ],
    [
      'POST',
      '/v1/rag/collections/docs/answer',
      { question: 'why?' },
      'answer',
      { question: 'why?', collection: 'docs' },
    ],
  ] as const)('%s %s → RagQuery/%s', async (method, url, payload, handler, request) => {
    const { app, cp } = api();
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(200);
    expect(cp.ingress.serviceCalls).toMatchObject([{ service: 'RagQuery', handler }]);
    expect(cp.ingress.serviceCalls[0]!.request).toEqual(request);
  });

  it('passes RagQuery’s answer through untouched', async () => {
    const { app, cp } = api();
    const answer = {
      answer: 'Restate journals each step [S1].',
      citations: [{ id: 'S1', documentId: 'a', chunkIndex: 0, score: 0.82 }],
      status: 'answered',
      usage: null,
      nested: { deep: [1, 'two', { three: true }], unicode: 'naïve — ✓' },
    };
    cp.ingress.serviceReply = answer;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/answer',
      payload: { question: 'why?' },
    });
    expect(res.json()).toEqual(answer);
  });

  it('gives an answer the longer timeout, and everything else the query timeout', async () => {
    const { app, cp } = api();
    await app.inject({ url: '/v1/rag/collections/docs' });
    await app.inject({ method: 'POST', url: '/v1/rag/collections/docs/search', payload: {} });
    await app.inject({ method: 'POST', url: '/v1/rag/collections/docs/answer', payload: {} });
    expect(cp.ingress.serviceCalls.map((c) => c.options.timeoutMs)).toEqual([1_000, 1_000, 9_000]);
  });

  it('gives a reranked search the answer timeout: a rerank calls a model per candidate', async () => {
    const { app, cp } = api();
    const search = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/rag/collections/docs/search', payload });
    await search({ query: 'q', rerank: {} });
    await search({ query: 'q', rerank: { candidates: 20, topK: 5 } });
    await search({ query: 'q' });
    // Not an object: RagQuery refuses it, and quickly.
    await search({ query: 'q', rerank: true });
    expect(cp.ingress.serviceCalls.map((c) => c.options.timeoutMs)).toEqual([
      9_000, 9_000, 1_000, 1_000,
    ]);
  });

  it.each(['answer', 'search'])(
    'binds a %s’s Idempotency-Key to the request, and sends Restate a hash of it',
    async (handler) => {
      const { app, cp } = api();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/rag/collections/docs/${handler}`,
        headers: { 'idempotency-key': 'k-1' },
        payload: { question: 'why?', query: 'why?' },
      });
      expect(res.statusCode).toBe(200);
      const key = cp.ingress.serviceCalls[0]!.options.idempotencyKey;
      expect(key).toMatch(/^[0-9a-f]{64}:[0-9a-f]{32}$/);
      expect(key).not.toContain('k-1');
    },
  );

  it('passes a non-ASCII Idempotency-Key on, as an ASCII one Restate accepts', async () => {
    const { app, cp } = api();
    // Node decodes header bytes as latin1: UTF-8 "café-1" arrives as "cafÃ©-1".
    const key = Buffer.from('café-1', 'utf8').toString('latin1');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/answer',
      headers: { 'idempotency-key': key },
      payload: { question: 'why?' },
    });
    expect(res.statusCode).toBe(200);
    expect(cp.ingress.serviceCalls[0]!.options.idempotencyKey).toMatch(
      /^[0-9a-f]{64}:[0-9a-f]{32}$/,
    );
  });

  it('accepts a cursor of 2048 characters: an id of 512 three-byte characters encodes to one', async () => {
    const { app, cp } = api();
    const cursor = Buffer.from('क'.repeat(512), 'utf8').toString('base64url');
    expect(cursor).toHaveLength(2048);
    const res = await app.inject({ url: `/v1/rag/collections/docs/documents?cursor=${cursor}` });
    expect(res.statusCode).toBe(200);
    expect(cp.ingress.serviceCalls[0]!.request).toEqual({ collection: 'docs', cursor });
  });

  it.each([
    ['a collection name over 63 characters', 'GET', `/v1/rag/collections/${'a'.repeat(64)}`],
    ['a query parameter on the collection list', 'GET', '/v1/rag/collections?limit=5'],
    ['a limit below 1', 'GET', '/v1/rag/collections/docs/documents?limit=0'],
    ['a limit above 200', 'GET', '/v1/rag/collections/docs/documents?limit=201'],
    ['a limit that is not a number', 'GET', '/v1/rag/collections/docs/documents?limit=x'],
    ['a limit in hexadecimal', 'GET', '/v1/rag/collections/docs/documents?limit=0x10'],
    ['a limit in exponent form', 'GET', '/v1/rag/collections/docs/documents?limit=1e2'],
    ['a limit given twice', 'GET', '/v1/rag/collections/docs/documents?limit=1&limit=2'],
    [
      'a cursor over 2048 characters',
      'GET',
      `/v1/rag/collections/docs/documents?cursor=${'A'.repeat(2049)}`,
    ],
    ['an unknown query parameter', 'GET', '/v1/rag/collections/docs/documents?offset=10'],
    ['chunks that is not true or false', 'GET', '/v1/rag/collections/docs/documents/a?chunks=1'],
    ['a query parameter on a collection', 'GET', '/v1/rag/collections/docs?verbose=1'],
    [
      'a query parameter on a search',
      'POST',
      '/v1/rag/collections/docs/search?topK=3',
      { query: 'q' },
    ],
    ['a body that is not an object', 'POST', '/v1/rag/collections/docs/search', [1, 2]],
    ['a missing body', 'POST', '/v1/rag/collections/docs/search'],
  ] as const)('refuses %s before calling anything', async (_what, method, url, payload?) => {
    const { app, cp } = api();
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(cp.ingress.serviceCalls).toEqual([]);
  });

  describe('a request body nested too deep', () => {
    /** A JSON body `depth` levels deep: the object, `filter`, then nested arrays. */
    const nested = (depth: number, field: string) =>
      `{"${field}":"q","filter":{"a":${'['.repeat(depth - 2)}${']'.repeat(depth - 2)}}}`;
    const post = (app: ReturnType<typeof api>['app'], path: string, payload: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/rag/collections/docs/${path}`,
        headers: { 'content-type': 'application/json' },
        payload,
      });

    it('is refused beyond 64 levels, before anything serialises it', async () => {
      const { app, cp } = api();
      for (const [path, field] of [
        ['search', 'query'],
        ['answer', 'question'],
        ['documents', 'documents'],
      ] as const) {
        const res = await post(app, path, nested(65, field));
        expect(res.statusCode, path).toBe(400);
        expect(res.json().error).toEqual({
          code: 'INVALID_REQUEST',
          message: '(root): the body nests deeper than 64 levels',
        });
      }
      expect(cp.ingress.serviceCalls).toEqual([]);
      expect(cp.ingress.submissions).toEqual([]);
    });

    it('is refused at thousands of levels too, without overflowing the stack', async () => {
      const { app } = api();
      const res = await post(app, 'answer', nested(20_000, 'question'));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_REQUEST');
    });

    it('is accepted at 64 levels', async () => {
      const { app, cp } = api();
      const res = await post(app, 'search', nested(64, 'query'));
      expect(res.statusCode).toBe(200);
      expect(cp.ingress.serviceCalls).toHaveLength(1);
    });
  });

  it.each(['search', 'answer'])(
    'refuses a %s body over 64 KiB: a question and a filter are small',
    async (path) => {
      const { app, cp } = api();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/rag/collections/docs/${path}`,
        payload: { query: 'q', question: 'q', filter: { a: 'x'.repeat(64 * 1024) } },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('INVALID_REQUEST');
      expect(cp.ingress.serviceCalls).toEqual([]);
    },
  );

  it('refuses a malformed Idempotency-Key', async () => {
    const { app, cp } = api();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/answer',
      headers: { 'idempotency-key': 'k'.repeat(257) },
      payload: { question: 'why?' },
    });
    expect(res.statusCode).toBe(400);
    expect(cp.ingress.serviceCalls).toEqual([]);
  });

  it('reports a failed call in the error envelope', async () => {
    const { app, cp } = api();
    cp.ingress.serviceReply = new ServiceCallError('invocation', 'collection docs not found', 404);
    const missing = await app.inject({ url: '/v1/rag/collections/docs' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'collection docs not found' },
    });

    cp.ingress.serviceReply = new ServiceCallError('timeout', 'no answer within 9000 ms');
    const slow = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/answer',
      payload: { question: 'why?' },
    });
    expect(slow.statusCode).toBe(504);
    expect(slow.json().error.code).toBe('RESTATE_UNAVAILABLE');
  });

  it('says rag-query is not deployed rather than failing at the ingress', async () => {
    const { app } = api({ deployed: false });
    const res = await app.inject({ url: '/v1/rag/collections' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'NOT_DEPLOYED', message: 'rag-query is not deployed' },
    });
  });
});

describe('changes', () => {
  const inputOf = (cp: ReturnType<typeof api>['cp']) =>
    (cp.ingress.submissions[0]!.request as { input: unknown }).input;

  it('starts a rag-ingest run to upsert, and points at it', async () => {
    const { app, cp } = api();
    const documents = [{ id: 'a', text: 'Restate journals every step.' }];
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/documents',
      headers: { 'idempotency-key': 'upsert-1' },
      payload: { documents },
    });

    expect(res.statusCode).toBe(202);
    const accepted = res.json();
    expect(accepted).toEqual({
      runId: expect.stringMatching(/^api_[0-9a-f]{32}$/),
      invocationId: 'inv_1',
      status: 'Accepted',
    });
    expect(res.headers.location).toBe(`/v1/runs/rag-ingest/${accepted.runId}`);
    expect(inputOf(cp)).toEqual({ operation: 'upsert', collection: 'docs', documents });
    expect(cp.ingress.submissions[0]!.request).toMatchObject({
      trigger: { idempotencyKey: 'upsert-1' },
    });
  });

  it('refuses an upsert without documents', async () => {
    const { app, cp } = api();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/documents',
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(cp.ingress.submissions).toEqual([]);
  });

  it('deletes a document whose id needs encoding in the path', async () => {
    const { app, cp } = api();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/rag/collections/docs/documents/guides%2Fintro.md',
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe(`/v1/runs/rag-ingest/${res.json().runId}`);
    expect(inputOf(cp)).toEqual({
      operation: 'delete',
      collection: 'docs',
      documentIds: ['guides/intro.md'],
    });
  });

  it('orders a deletion by the version it is given', async () => {
    const { app, cp } = api();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/rag/collections/docs/documents/a?version=1757930000000',
    });
    expect(res.statusCode).toBe(202);
    expect(inputOf(cp)).toEqual({
      operation: 'delete',
      collection: 'docs',
      documentIds: ['a'],
      version: 1757930000000,
    });
  });

  it('drops a collection', async () => {
    const { app, cp } = api();
    const res = await app.inject({ method: 'DELETE', url: '/v1/rag/collections/docs' });
    expect(res.statusCode).toBe(202);
    expect(inputOf(cp)).toEqual({ operation: 'drop', collection: 'docs' });
  });

  it('takes a document over 64 KiB: only searches and answers are held to that', async () => {
    const { app, cp } = api();
    const documents = [{ id: 'a', text: 'x'.repeat(256 * 1024) }];
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rag/collections/docs/documents',
      payload: { documents },
    });
    expect(res.statusCode).toBe(202);
    expect(inputOf(cp)).toMatchObject({ operation: 'upsert', documents });
  });

  // A DELETE says it all in its path: a body or a stray query parameter is a mistaken call — a bulk
  // delete, a document delete that lost its `/documents/:id` — and must not drop the collection.
  it.each([
    ['a body on a drop', '/v1/rag/collections/docs', { documentIds: ['a', 'b'] }],
    ['a query parameter on a drop', '/v1/rag/collections/docs?version=5', undefined],
    ['a body on a document delete', '/v1/rag/collections/docs/documents/a', { version: 5 }],
    ['a version that is not a count', '/v1/rag/collections/docs/documents/a?version=-1', undefined],
    ['an empty version', '/v1/rag/collections/docs/documents/a?version=', undefined],
  ] as const)('refuses %s before starting anything', async (_what, url, payload) => {
    const { app, cp } = api();
    const res = await app.inject({ method: 'DELETE', url, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(cp.ingress.submissions).toEqual([]);
  });

  it('says so when a DELETE carries a body', async () => {
    const { app } = api();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/rag/collections/docs',
      payload: { documentIds: ['a'] },
    });
    expect(res.json()).toEqual({
      error: { code: 'INVALID_REQUEST', message: '(root): this route takes no body' },
    });
  });

  it('lets an empty JSON object through on a DELETE, as some clients always send one', async () => {
    const { app, cp } = api();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/rag/collections/docs',
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(inputOf(cp)).toEqual({ operation: 'drop', collection: 'docs' });
  });
});
