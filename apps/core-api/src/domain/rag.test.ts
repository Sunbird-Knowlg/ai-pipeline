import { describe, expect, it } from 'vitest';
import { PipelineError } from '../errors.js';
import { ServiceCallError } from '../restate/ingress.js';
import type { Seed } from '../testing/store.js';
import {
  definitionOf,
  deploymentOf,
  fakeControlPlane,
  metadataOf,
  triggerOf,
} from '../testing/restate.js';
import {
  deleteDocument,
  dropCollection,
  queryRag,
  requestScopedKey,
  resolveRagQuery,
  upsertDocuments,
} from './rag.js';

/**
 * The RAG rules: which unit answers, what its failures mean to an API caller, and how an
 * Idempotency-Key is kept from returning a stale answer. Both units are reached by name only, so
 * these tests catalogue them the way a deploy would and never import either one.
 */

const ragQuery = () =>
  definitionOf({
    metadata: metadataOf({ name: 'rag-query', restateName: 'RagQuery', kind: 'service' }),
  });

/** A stand-in for `rag-ingest`'s catalogued input: a union on `operation`, as the unit declares. */
const INGEST_INPUT = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        operation: { const: 'upsert' },
        collection: { type: 'string' },
        documents: { type: 'array', minItems: 1 },
        options: { type: 'object' },
      },
      required: ['operation', 'collection', 'documents'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        operation: { const: 'delete' },
        collection: { type: 'string' },
        documentIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['operation', 'collection', 'documentIds'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { operation: { const: 'drop' }, collection: { type: 'string' } },
      required: ['operation', 'collection'],
      additionalProperties: false,
    },
  ],
};

const ragIngest = () =>
  definitionOf({
    metadata: metadataOf({ name: 'rag-ingest', restateName: 'RagIngest' }),
    schemas: { input: INGEST_INPUT, output: { type: 'object' }, config: { type: 'object' } },
  });

/** Both units catalogued, deployed and active, and rag-ingest's REST trigger on. */
const ready = (seed: Partial<Seed> = {}) =>
  fakeControlPlane({
    seed: {
      definitions: [ragQuery(), ragIngest()],
      deployments: [
        deploymentOf({ deploymentId: 'dp_q', name: 'rag-query', status: 'active' }),
        deploymentOf({ deploymentId: 'dp_i', name: 'rag-ingest', status: 'active' }),
      ],
      triggers: [triggerOf({ name: 'rag-ingest' })],
      ...seed,
    },
  });

const OPTIONS = { timeoutMs: 30_000 };

describe('queryRag', () => {
  it('calls the active rag-query by its Restate name and returns its answer untouched', async () => {
    const cp = ready();
    const answer = { hits: [{ id: 'c-1', score: 0.9, metadata: { tags: ['a'], n: null } }] };
    cp.ingress.serviceReply = answer;

    await expect(
      queryRag(cp, 'search', { collection: 'docs', query: 'restate' }, OPTIONS),
    ).resolves.toEqual(answer);
    expect(cp.ingress.serviceCalls).toEqual([
      {
        service: 'RagQuery',
        handler: 'search',
        request: { collection: 'docs', query: 'restate' },
        options: { timeoutMs: 30_000 },
      },
    ]);
  });

  describe('refuses with NOT_DEPLOYED, before reaching Restate', () => {
    const refused = async (cp: ReturnType<typeof ready>) => {
      await expect(queryRag(cp, 'listCollections', {}, OPTIONS)).rejects.toMatchObject({
        code: 'NOT_DEPLOYED',
        statusCode: 409,
        message: expect.stringMatching(/^rag-query is not deployed/),
      });
      expect(cp.ingress.serviceCalls).toEqual([]);
    };

    it('when rag-query is not catalogued', () => refused(ready({ definitions: [ragIngest()] })));

    it('when nothing of it is active', () =>
      refused(
        ready({
          deployments: [deploymentOf({ name: 'rag-query', status: 'draining' })],
        }),
      ));

    it('when its current version is a private service, which the ingress would not serve', () =>
      refused(
        ready({
          definitions: [
            definitionOf({
              metadata: metadataOf({
                name: 'rag-query',
                restateName: 'RagQuery',
                kind: 'service',
                visibility: 'private',
              }),
            }),
          ],
        }),
      ));

    it('when the name is catalogued as a workflow', () =>
      refused(
        ready({
          definitions: [
            definitionOf({ metadata: metadataOf({ name: 'rag-query', restateName: 'RagQuery' }) }),
          ],
        }),
      ));
  });

  it('resolves to the Restate name the catalogue records', async () => {
    await expect(resolveRagQuery(ready())).resolves.toBe('RagQuery');
  });
});

describe('a failed RagQuery call', () => {
  const failing = (error: Error) => {
    const cp = ready();
    cp.ingress.serviceReply = error;
    return queryRag(cp, 'answer', { collection: 'docs', question: 'why?' }, OPTIONS).catch(
      (e: unknown) => e,
    );
  };

  // The handler's TerminalError code is the HTTP status, so 4xx is "your request is wrong" and the
  // rest is "the service failed". Refusals by the ingress and transport failures are never the
  // caller's fault, and say so with the retryable codes.
  it.each([
    ['invocation', 400, 'INVALID_INPUT', 400],
    ['invocation', 404, 'NOT_FOUND', 404],
    ['invocation', 409, 'RESTATE_INGRESS_ERROR', 502],
    ['invocation', 422, 'INVALID_REQUEST', 422],
    ['invocation', 500, 'RESTATE_INGRESS_ERROR', 502],
    ['invocation', 503, 'RESTATE_INGRESS_ERROR', 502],
    ['ingress', 404, 'RESTATE_INGRESS_ERROR', 502],
    ['ingress', 429, 'RESTATE_UNAVAILABLE', 503],
    ['ingress', 503, 'RESTATE_UNAVAILABLE', 503],
    ['ingress', 400, 'RESTATE_INGRESS_ERROR', 502],
    ['ingress', 500, 'RESTATE_INGRESS_ERROR', 502],
    ['ingress', undefined, 'RESTATE_INGRESS_ERROR', 502],
    ['timeout', undefined, 'RESTATE_UNAVAILABLE', 504],
    ['network', undefined, 'RESTATE_UNAVAILABLE', 503],
  ] as const)('%s %s → %s (%i)', async (kind, status, code, statusCode) => {
    const error = await failing(new ServiceCallError(kind, 'boom', status));
    expect(error).toMatchObject({ code, statusCode });
  });

  it('passes a caller error on in the handler’s own words', async () => {
    const message = 'Failed to deserialize input: collection: Invalid string';
    const error = await failing(new ServiceCallError('invocation', message, 400));
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message });
  });

  it('names the call that failed when the service itself failed', async () => {
    const error = await failing(new ServiceCallError('invocation', 'embedding failed', 500));
    expect(error).toMatchObject({ message: 'RagQuery/answer failed: embedding failed' });
  });

  // RagQuery raises no 409 of its own: Restate ends a canceled or killed invocation with one, and
  // that is an operator's doing, never "fix your request".
  it.each(['killed', 'canceled'])(
    'reports a %s query as a failure, not the caller’s',
    async (how) => {
      const error = await failing(new ServiceCallError('invocation', how, 409));
      expect(error).toMatchObject({
        code: 'RESTATE_INGRESS_ERROR',
        statusCode: 502,
        message: `RagQuery/answer was canceled or killed before it answered: ${how}`,
      });
    },
  );

  it('says Restate does not know a service the catalogue has deployed', async () => {
    const error = await failing(new ServiceCallError('ingress', 'service not found', 404));
    expect((error as Error).message).toMatch(/^Restate does not know RagQuery\/answer/);
  });

  it('says how long it waited', async () => {
    const error = await failing(new ServiceCallError('timeout', 'no answer'));
    expect(error).toMatchObject({ message: 'RagQuery/answer did not answer within 30000 ms' });
  });

  it('truncates a long message to 500 characters', async () => {
    const error = await failing(new ServiceCallError('invocation', 'x'.repeat(5_000), 400));
    expect((error as Error).message).toHaveLength(500);
  });

  it('lets anything that is not a call failure through unchanged', async () => {
    const bug = new TypeError('not a call failure');
    await expect(failing(bug)).resolves.toBe(bug);
  });
});

describe('an Idempotency-Key on a query', () => {
  const keyOf = async (request: Record<string, unknown>, idempotencyKey?: string) => {
    const cp = ready();
    await queryRag(cp, 'answer', request, { ...OPTIONS, idempotencyKey });
    return cp.ingress.serviceCalls[0]!.options.idempotencyKey;
  };

  it('is not invented when the caller sent none', async () => {
    await expect(keyOf({ collection: 'docs', question: 'why?' })).resolves.toBeUndefined();
  });

  it('reaches Restate as a hash of the key, bound to the request', async () => {
    const key = await keyOf({ collection: 'docs', question: 'why?' }, 'k-1');
    expect(key).toMatch(/^[0-9a-f]{64}:[0-9a-f]{32}$/);
    expect(key).not.toContain('k-1');
    expect(key).toBe(requestScopedKey('k-1', { collection: 'docs', question: 'why?' }));
  });

  // Restate reads the header as visible ASCII only, and would refuse this one with a 400 that the
  // caller would see as a 502. Node hands a header's bytes over as latin1.
  it('is ASCII and bounded whatever the caller’s key holds', async () => {
    for (const caller of [Buffer.from('café-1', 'utf8').toString('latin1'), 'k'.repeat(256)]) {
      const key = await keyOf({ collection: 'docs', question: 'why?' }, caller);
      expect(key).toMatch(/^[0-9a-f]{64}:[0-9a-f]{32}$/);
    }
  });

  it('differs for two keys with the same request', async () => {
    const request = { collection: 'docs', question: 'why?' };
    expect(await keyOf(request, 'k-1')).not.toBe(await keyOf(request, 'k-2'));
  });

  it('gives a different question a different call, so a reused key never returns a stale answer', async () => {
    const first = await keyOf({ collection: 'docs', question: 'why?' }, 'k-1');
    const other = await keyOf({ collection: 'docs', question: 'how?' }, 'k-1');
    const elsewhere = await keyOf({ collection: 'notes', question: 'why?' }, 'k-1');
    expect(new Set([first, other, elsewhere]).size).toBe(3);
  });

  it('gives a retry of the same question the same call, whatever the key order', async () => {
    const first = await keyOf({ collection: 'docs', question: 'why?', topK: 3 }, 'k-1');
    const retry = await keyOf({ topK: 3, question: 'why?', collection: 'docs' }, 'k-1');
    expect(retry).toBe(first);
  });
});

describe('document changes', () => {
  const inputOf = (cp: ReturnType<typeof ready>) =>
    (cp.ingress.submissions[0]!.request as { input: unknown }).input;

  it('upserts through a rag-ingest run, validated against its catalogued schema', async () => {
    const cp = ready();
    const documents = [{ id: 'a', text: 'Restate journals every step.' }];
    const accepted = await upsertDocuments(cp, 'docs', { documents }, 'key-1');

    expect(accepted).toMatchObject({ status: 'Accepted', invocationId: 'inv_1' });
    expect(cp.ingress.submissions[0]).toMatchObject({
      restateName: 'RagIngest',
      runId: accepted.runId,
      request: { trigger: { type: 'rest', id: 'api', idempotencyKey: 'key-1' } },
    });
    expect(inputOf(cp)).toEqual({ operation: 'upsert', collection: 'docs', documents });
  });

  it('takes the collection from the path and the operation from the route, whatever the body says', async () => {
    const cp = ready();
    const documents = [{ id: 'a', text: 'x' }];
    await upsertDocuments(cp, 'docs', { documents, collection: 'other', operation: 'drop' });
    expect(inputOf(cp)).toEqual({ operation: 'upsert', collection: 'docs', documents });
  });

  it('refuses a body with no documents before starting anything', async () => {
    const cp = ready();
    await expect(upsertDocuments(cp, 'docs', { text: 'x' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      statusCode: 400,
    });
    expect(cp.ingress.submissions).toEqual([]);
  });

  it('refuses documents the catalogued schema rejects, naming the unit', async () => {
    const cp = ready();
    await expect(upsertDocuments(cp, 'docs', { documents: [] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      statusCode: 400,
      message: expect.stringContaining('rag-ingest'),
    });
    expect(cp.ingress.submissions).toEqual([]);
  });

  it('deletes one document by id', async () => {
    const cp = ready();
    await deleteDocument(cp, 'docs', 'guides/intro.md');
    expect(inputOf(cp)).toEqual({
      operation: 'delete',
      collection: 'docs',
      documentIds: ['guides/intro.md'],
    });
  });

  it('passes a deletion’s version on, so it is ordered against the upserts', async () => {
    const cp = ready();
    await deleteDocument(cp, 'docs', 'a', { version: 7 });
    expect(inputOf(cp)).toEqual({
      operation: 'delete',
      collection: 'docs',
      documentIds: ['a'],
      version: 7,
    });
  });

  it('drops a collection', async () => {
    const cp = ready();
    await dropCollection(cp, 'docs');
    expect(inputOf(cp)).toEqual({ operation: 'drop', collection: 'docs' });
  });

  it('says rag-ingest is not deployed, not "not found", when it is not catalogued', async () => {
    const cp = ready({ definitions: [ragQuery()] });
    await expect(dropCollection(cp, 'docs')).rejects.toMatchObject({
      code: 'NOT_DEPLOYED',
      statusCode: 409,
      message: 'rag-ingest is not deployed',
    });
    expect(cp.ingress.submissions).toEqual([]);
  });

  it('keeps startRun’s refusals once rag-ingest is catalogued', async () => {
    const cp = ready({ deployments: [deploymentOf({ name: 'rag-ingest', status: 'draining' })] });
    await expect(dropCollection(cp, 'docs')).rejects.toMatchObject({
      code: 'NOT_DEPLOYED',
      message: 'rag-ingest has no active deployment',
    });
  });

  // The catalogue has rag-ingest active, but Restate has lost it (a reset, a deployment deleted by
  // hand). Its ingress answers 404, which on these paths would read as "no such document".
  it('says Restate does not know rag-ingest, with a 502 rather than its ingress’s 404', async () => {
    const cp = ready();
    const lost = new PipelineError(
      'RESTATE_INGRESS_ERROR',
      "Restate ingress: service 'RagIngest' not found, make sure to register the service before calling it.",
      404,
    );
    cp.ingress.submitWorkflow = async () => {
      throw lost;
    };
    for (const change of [
      () => deleteDocument(cp, 'docs', 'a'),
      () => dropCollection(cp, 'docs'),
      () => upsertDocuments(cp, 'docs', { documents: [{ id: 'a', text: 'x' }] }),
    ]) {
      const error = await change().catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'RESTATE_INGRESS_ERROR',
        statusCode: 502,
        message: `Restate does not know RagIngest/run, though the catalogue has it deployed: ${lost.message}`,
      });
      expect((error as Error).cause).toBe(lost);
    }
  });

  it('passes Restate’s other failures through as they are', async () => {
    const cp = ready();
    const down = new PipelineError('RESTATE_UNAVAILABLE', 'Restate ingress is unavailable', 503);
    cp.ingress.submitWorkflow = async () => {
      throw down;
    };
    await expect(dropCollection(cp, 'docs')).rejects.toBe(down);
  });
});
