import { idempotencyKey, opaqueJson } from '@ai-pipeline/api-contract/params';
import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import { startRunAccepted, type StartRunAccepted } from '@ai-pipeline/api-contract/workflows';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  deleteDocument,
  dropCollection,
  queryRag,
  RAG_INGEST,
  upsertDocuments,
} from '../domain/rag.js';

export interface RagRouteOptions {
  /** How long a read or a search may take, in ms. */
  queryMs: number;
  /** How long an answer, or a search that reranks, may take, in ms: they wait on an LLM. */
  answerMs: number;
}

/** A search or an answer is a question and a filter. Only documents need the app's 1 MiB. */
const QUERY_BODY_LIMIT = 64 * 1024;

/**
 * Deeper than any filter or document needs. A deeper body is refused before anything serialises it:
 * digesting or encoding one thousands of levels deep overflows the stack.
 */
const MAX_BODY_DEPTH = 64;

// Only what is needed to route a request is checked here. Everything else is the units' to
// validate: `RagQuery` checks its own requests, and `startRun` checks a run's input against the
// catalogued schema.
const collectionParams = z.object({ collection: z.string().min(1).max(63) });
const documentParams = collectionParams.extend({ documentId: z.string().min(1).max(512) });
/** Routes that take no query string say so, rather than ignoring a mistyped parameter. */
const noQuery = z.strictObject({});
// A query string carries text, and the units want numbers: decimal digits only, so neither `0x10`
// nor `1e2` passes for one.
const documentsQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().min(1).max(200))
    .optional(),
  // A `nextCursor` as `RagQuery` hands it out: the page's last document id, base64url-encoded. An id
  // of 512 UTF-16 units is up to 1,536 UTF-8 bytes, which encode to 2,048 characters.
  cursor: z.string().min(1).max(2048).optional(),
});
const documentQuery = z.strictObject({
  chunks: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
// The unit checks the range.
const deleteQuery = z.strictObject({
  version: z
    .string()
    .regex(/^\d{1,20}$/)
    .transform(Number)
    .optional(),
});
/** Any JSON object, nested at most `MAX_BODY_DEPTH` deep. What it holds is the unit's contract. */
const objectBody = z
  .record(z.string(), z.unknown())
  .refine(
    (body) => nestsWithin(body, MAX_BODY_DEPTH),
    `the body nests deeper than ${MAX_BODY_DEPTH} levels`,
  );
/**
 * A DELETE says everything in its path. A body sent with one is a mistaken call — a bulk delete
 * that would otherwise drop the whole collection — so it is refused, never ignored.
 */
const noBody = z
  .unknown()
  .refine(
    (body) =>
      body === undefined ||
      body === null ||
      body === '' ||
      (isObject(body) && Object.keys(body).length === 0),
    'this route takes no body',
  );

/** `RagQuery`'s own JSON, passed through untouched as a run's `output` is. */
const answered = { schema: { response: { 200: responseSchema(opaqueJson) } } };
const accepted = { schema: { response: { 202: responseSchema(startRunAccepted) } } };

/**
 * Retrieval-augmented generation: collections, documents, search and answers.
 *
 * Reads are calls to the `rag-query` service. Changes start `rag-ingest` runs and are answered 202,
 * as any other run start is; the run says how each document fared.
 */
export async function ragRoutes(app: FastifyInstance, options: RagRouteOptions): Promise<void> {
  const cp = app.controlPlane;
  const read = { timeoutMs: options.queryMs };

  app.get('/rag/collections', answered, async (request) => {
    noQuery.parse(request.query);
    return queryRag(cp, 'listCollections', {}, read);
  });

  app.get('/rag/collections/:collection', answered, async (request) => {
    const params = collectionParams.parse(request.params);
    noQuery.parse(request.query);
    return queryRag(cp, 'getCollection', params, read);
  });

  app.get('/rag/collections/:collection/documents', answered, async (request) => {
    const { collection } = collectionParams.parse(request.params);
    const page = documentsQuery.parse(request.query);
    return queryRag(cp, 'listDocuments', { collection, ...page }, read);
  });

  app.get('/rag/collections/:collection/documents/:documentId', answered, async (request) => {
    const document = documentParams.parse(request.params);
    const options = documentQuery.parse(request.query);
    return queryRag(cp, 'getDocument', { ...document, ...options }, read);
  });

  // The path names the collection; a `collection` in the body cannot point elsewhere. An
  // `Idempotency-Key` works as it does for an answer.
  app.post(
    '/rag/collections/:collection/search',
    { ...answered, bodyLimit: QUERY_BODY_LIMIT },
    async (request) => {
      const { collection } = collectionParams.parse(request.params);
      noQuery.parse(request.query);
      const body = objectBody.parse(request.body);
      // A rerank makes a model call per candidate, so it may take as long as an answer.
      const timeoutMs = isObject(body.rerank) ? options.answerMs : options.queryMs;
      const idempotencyKey = idempotencyKeyOf(request);
      return queryRag(cp, 'search', { ...body, collection }, { timeoutMs, idempotencyKey });
    },
  );

  // The slow and costly call, so the one worth retrying safely: with an `Idempotency-Key`, a retry
  // of the same question gets the answer Restate already holds instead of a second LLM call.
  app.post(
    '/rag/collections/:collection/answer',
    { ...answered, bodyLimit: QUERY_BODY_LIMIT },
    async (request) => {
      const { collection } = collectionParams.parse(request.params);
      noQuery.parse(request.query);
      const question = { ...objectBody.parse(request.body), collection };
      return queryRag(cp, 'answer', question, {
        timeoutMs: options.answerMs,
        idempotencyKey: idempotencyKeyOf(request),
      });
    },
  );

  app.post('/rag/collections/:collection/documents', accepted, async (request, reply) => {
    const { collection } = collectionParams.parse(request.params);
    noQuery.parse(request.query);
    const body = objectBody.parse(request.body);
    return started(reply, await upsertDocuments(cp, collection, body, idempotencyKeyOf(request)));
  });

  app.delete(
    '/rag/collections/:collection/documents/:documentId',
    accepted,
    async (request, reply) => {
      const { collection, documentId } = documentParams.parse(request.params);
      const { version } = deleteQuery.parse(request.query);
      noBody.parse(request.body);
      const options = { version, idempotencyKey: idempotencyKeyOf(request) };
      return started(reply, await deleteDocument(cp, collection, documentId, options));
    },
  );

  app.delete('/rag/collections/:collection', accepted, async (request, reply) => {
    const { collection } = collectionParams.parse(request.params);
    noQuery.parse(request.query);
    noBody.parse(request.body);
    return started(reply, await dropCollection(cp, collection, idempotencyKeyOf(request)));
  });
}

function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return header === undefined ? undefined : idempotencyKey.parse(header);
}

/** 202, pointing at the run to follow, as `POST /v1/workflows/:name/runs` answers. */
function started(reply: FastifyReply, run: StartRunAccepted): FastifyReply {
  return reply.code(202).header('location', `/v1/runs/${RAG_INGEST}/${run.runId}`).send(run);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether `value` nests at most `limit` deep, counting each object and array as a level. Iterative,
 * and it stops at the first node too deep: the body is the caller's, and recursing through thousands
 * of levels is the very thing this guards against.
 */
function nestsWithin(value: unknown, limit: number): boolean {
  const pending: [node: unknown, depth: number][] = [[value, 1]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop()!;
    if (typeof node !== 'object' || node === null) continue;
    if (depth > limit) return false;
    for (const child of Object.values(node as Record<string, unknown>))
      pending.push([child, depth + 1]);
  }
  return true;
}
