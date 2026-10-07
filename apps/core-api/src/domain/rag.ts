import { createHash } from 'node:crypto';
import type { PipelineErrorCode } from '@ai-pipeline/api-contract/errors';
import type { StartRunAccepted } from '@ai-pipeline/api-contract/workflows';
import { assert, PipelineError } from '../errors.js';
import { ServiceCallError } from '../restate/ingress.js';
import type { ControlPlane } from './deps.js';
import { requestDigest, startRun } from './runs.js';

/**
 * The RAG API. Queries are answered by the `rag-query` service; document changes are runs of the
 * `rag-ingest` workflow.
 *
 * Both pass through core-api without it knowing their shapes, the way a run's `output` does: the
 * units own their contracts, and core-api imports neither. `RagQuery` validates its own requests,
 * and `startRun` validates a run's input against the catalogued schema. What this module owns is
 * the routing (which unit, which handler) and what a failure means to an API caller.
 */

const RAG_QUERY = 'rag-query';
export const RAG_INGEST = 'rag-ingest';

/** `RagQuery`'s handlers, by name. */
export type RagQueryHandler =
  'listCollections' | 'getCollection' | 'listDocuments' | 'getDocument' | 'search' | 'answer';

export interface RagQueryOptions {
  /**
   * The caller's `Idempotency-Key`. Restate is sent `requestScopedKey`'s hash of it, bound to the
   * request, never the key itself.
   */
  idempotencyKey?: string;
  /** How long to wait for the answer before answering 504. */
  timeoutMs: number;
}

/**
 * The Restate name of `rag-query`, once it can be called.
 *
 * The routes call it through the Restate ingress, which serves only public services. A private or
 * undeployed one is refused here, with a message saying so, instead of reaching the ingress and
 * coming back as an error that reads like an outage.
 */
export async function resolveRagQuery(cp: ControlPlane): Promise<string> {
  const definition = await cp.store.definitions.current(RAG_QUERY);
  if (!definition) throw notDeployed(RAG_QUERY);
  if (definition.kind !== 'service' || definition.visibility !== 'public')
    throw notDeployed(RAG_QUERY, 'its current version is not a public service');
  const deployments = await cp.store.deployments.list(RAG_QUERY);
  if (!deployments.some((d) => d.status === 'active')) throw notDeployed(RAG_QUERY);
  return definition.restateName;
}

/** Calls one `RagQuery` handler and returns its answer untouched. */
export async function queryRag(
  cp: ControlPlane,
  handler: RagQueryHandler,
  request: Record<string, unknown>,
  options: RagQueryOptions,
): Promise<unknown> {
  const service = await resolveRagQuery(cp);
  try {
    return await cp.ingress.callService(service, handler, request, {
      timeoutMs: options.timeoutMs,
      ...(options.idempotencyKey
        ? { idempotencyKey: requestScopedKey(options.idempotencyKey, request) }
        : {}),
    });
  } catch (error) {
    if (error instanceof ServiceCallError)
      throw ragQueryError(error, `${service}/${handler}`, options.timeoutMs);
    throw error;
  }
}

/**
 * The key Restate sees for a caller's `Idempotency-Key`: a hash of the key, then a digest of the
 * request.
 *
 * Restate answers a repeated key with the first call's result, whatever the new request asks. For an
 * answer that would fail silently: a key reused for a different question would return the old
 * question's answer, with nothing to show it is stale. With the request in the key, a different
 * question is a different call, and a retry of the same one still gets the stored answer.
 *
 * The caller's key is hashed, never sent as it is: Restate reads the header as visible ASCII only
 * and refuses anything else, which would surface as a 502 for what is the caller's choice of key.
 * A hash is always ASCII, and always 64 characters however long the key.
 */
export const requestScopedKey = (key: string, request: unknown): string =>
  `${createHash('sha256').update(key).digest('hex')}:${requestDigest(request)}`;

/**
 * What a failed `RagQuery` call means to an API caller, in the codes the API already has.
 *
 * A handler's `TerminalError` code becomes the HTTP status, so the handler is the one deciding
 * between "your request is wrong" (4xx) and "I failed" (5xx). Refusals by the ingress and transport
 * failures are never the caller's fault.
 *
 * Except 409. `RagQuery` raises none of its own; Restate completes a canceled or killed invocation
 * with one (`canceled`, `killed`), and that is an operator's doing, not the caller's.
 */
function ragQueryError(error: ServiceCallError, target: string, timeoutMs: number): PipelineError {
  const status = error.status ?? 0;
  const fail = (code: PipelineErrorCode, message: string, statusCode: number) =>
    new PipelineError(code, message.slice(0, 500), statusCode, { cause: error });

  switch (error.kind) {
    case 'invocation':
      if (status === 400) return fail('INVALID_INPUT', error.message, 400);
      if (status === 404) return fail('NOT_FOUND', error.message, 404);
      if (status === 409)
        return fail(
          'RESTATE_INGRESS_ERROR',
          `${target} was canceled or killed before it answered: ${error.message}`,
          502,
        );
      if (status >= 400 && status < 500) return fail('INVALID_REQUEST', error.message, status);
      return fail('RESTATE_INGRESS_ERROR', `${target} failed: ${error.message}`, 502);
    case 'ingress':
      // The catalogue says the service is deployed and active, so Restate not knowing it is a
      // control-plane fault, not a missing resource.
      if (status === 404) return unknownToRestate(target, error.message, error);
      if (status === 429 || status === 503)
        return fail('RESTATE_UNAVAILABLE', `Restate ingress: ${error.message}`, 503);
      return fail('RESTATE_INGRESS_ERROR', `Restate ingress: ${error.message}`, 502);
    case 'timeout':
      return fail('RESTATE_UNAVAILABLE', `${target} did not answer within ${timeoutMs} ms`, 504);
    case 'network':
      return fail('RESTATE_UNAVAILABLE', 'Restate ingress is unavailable', 503);
  }
}

/** Adds or replaces documents in a collection, creating it on first use. */
export async function upsertDocuments(
  cp: ControlPlane,
  collection: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<StartRunAccepted> {
  assert(body.documents !== undefined, 'INVALID_REQUEST', 'the body must carry documents', 400);
  // The path names the collection and the route the operation: the body cannot override either.
  return ingest(cp, { ...body, operation: 'upsert', collection }, idempotencyKey);
}

/**
 * A producer that versions its documents passes the version of the deletion too, so the delete is
 * ordered against its upserts by version, not by when it arrived.
 */
export async function deleteDocument(
  cp: ControlPlane,
  collection: string,
  documentId: string,
  { version, idempotencyKey }: { version?: number; idempotencyKey?: string } = {},
): Promise<StartRunAccepted> {
  const input = {
    operation: 'delete',
    collection,
    documentIds: [documentId],
    ...(version === undefined ? {} : { version }),
  };
  return ingest(cp, input, idempotencyKey);
}

export async function dropCollection(
  cp: ControlPlane,
  collection: string,
  idempotencyKey?: string,
): Promise<StartRunAccepted> {
  return ingest(cp, { operation: 'drop', collection }, idempotencyKey);
}

/**
 * A `rag-ingest` run, through the same `startRun` as any REST trigger: its preconditions, its
 * schema validation and its idempotency.
 *
 * Two refusals are translated, because a 404 on these paths would read as "no such collection" or
 * "no such document". An uncatalogued `rag-ingest` is "not deployed", as `rag-query` is. And Restate
 * not knowing a `rag-ingest` the catalogue has active is a control-plane fault, a 502 — as it is
 * for `rag-query` — not the 404 its ingress answers.
 */
async function ingest(
  cp: ControlPlane,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<StartRunAccepted> {
  const definition = await cp.store.definitions.current(RAG_INGEST);
  if (!definition) throw notDeployed(RAG_INGEST);
  try {
    return await startRun(cp, RAG_INGEST, input, idempotencyKey);
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.code === 'RESTATE_INGRESS_ERROR' &&
      error.statusCode === 404
    )
      throw unknownToRestate(`${definition.restateName}/run`, error.message, error);
    throw error;
  }
}

/** Restate does not know `target`, which the catalogue has deployed and active. */
const unknownToRestate = (target: string, message: string, cause: Error) =>
  new PipelineError(
    'RESTATE_INGRESS_ERROR',
    `Restate does not know ${target}, though the catalogue has it deployed: ${message}`.slice(
      0,
      500,
    ),
    502,
    { cause },
  );

const notDeployed = (name: string, reason?: string) =>
  new PipelineError('NOT_DEPLOYED', `${name} is not deployed${reason ? `: ${reason}` : ''}`, 409);
