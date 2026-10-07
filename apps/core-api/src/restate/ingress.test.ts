import { describe, expect, it, vi } from 'vitest';
import type { PipelineError } from '../errors.js';
import { RestateIngress, ServiceCallError, type ServiceCallOptions } from './ingress.js';

/**
 * How a service call through the Restate ingress fails, classified by where the failure came from.
 * The adapter only classifies; what a failure means to an API caller is `domain/rag.ts`'s decision.
 */
function ingress(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) =>
    respond(String(input), init ?? {}),
  );
  return { client: new RestateIngress('http://restate:8080', fetchImpl), fetchImpl };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const call = (client: RestateIngress, options: ServiceCallOptions = { timeoutMs: 1_000 }) =>
  client
    .callService('RagQuery', 'search', { collection: 'docs', query: 'q' }, options)
    .catch((e: unknown) => e as ServiceCallError);

describe('callService', () => {
  it('posts the request to the handler by name and returns the answer', async () => {
    const answer = { hits: [{ id: 'c-1', score: 0.5 }] };
    const { client, fetchImpl } = ingress(() => json(200, answer));

    await expect(call(client)).resolves.toEqual(answer);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('http://restate:8080/RagQuery/search');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array))).toEqual({
      collection: 'docs',
      query: 'q',
    });
    expect(init!.headers).not.toHaveProperty('idempotency-key');
  });

  it('sends an idempotency key as Restate’s header', async () => {
    const { client, fetchImpl } = ingress(() => json(200, {}));
    await call(client, { timeoutMs: 1_000, idempotencyKey: 'k-1:abc' });
    expect(fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ 'idempotency-key': 'k-1:abc' });
  });

  it('classifies a handler failure as the invocation’s, with its status and message', async () => {
    const { client } = ingress(() =>
      json(400, {
        code: 400,
        message: 'Failed to deserialize input: query: Required',
        source: 'invocation',
      }),
    );
    const error = await call(client);
    expect(error).toBeInstanceOf(ServiceCallError);
    expect(error).toMatchObject({
      kind: 'invocation',
      status: 400,
      message: 'Failed to deserialize input: query: Required',
    });
  });

  it('classifies a refusal by the ingress as the ingress’s', async () => {
    const { client } = ingress(() =>
      json(404, { message: 'service RagQuery not found', source: 'ingress' }),
    );
    await expect(call(client)).resolves.toMatchObject({ kind: 'ingress', status: 404 });
  });

  it('does not blame the handler for a failure it cannot attribute to it', async () => {
    const { client } = ingress(() => new Response('<html>Bad Gateway</html>', { status: 400 }));
    await expect(call(client)).resolves.toMatchObject({
      kind: 'ingress',
      status: 400,
      message: '<html>Bad Gateway</html>',
    });
  });

  it('times out after timeoutMs, waiting for the answer included', async () => {
    // A fetch that never answers on its own: only the client's timeout signal ends it.
    const { client } = ingress(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // `AbortSignal.timeout` aborts with a `TimeoutError` DOMException, as `fetch` would reject.
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
        }),
    );
    const error = await call(client, { timeoutMs: 20 });
    expect(error).toMatchObject({ kind: 'timeout', message: 'no answer within 20 ms' });
  });

  it('classifies an abort as a timeout too', async () => {
    const { client } = ingress(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(call(client)).resolves.toMatchObject({ kind: 'timeout' });
  });

  it('classifies an unreachable ingress as a network failure, keeping the socket’s reason', async () => {
    // How Node's fetch (undici) fails to connect: a TypeError carrying the socket error.
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:8080'), {
      code: 'ECONNREFUSED',
    });
    const { client } = ingress(() => {
      throw new TypeError('fetch failed', { cause: refused });
    });
    await expect(call(client)).resolves.toMatchObject({
      kind: 'network',
      message: 'no answer from the ingress: ECONNREFUSED connect ECONNREFUSED 10.0.0.7:8080',
    });
  });

  it('classifies a connection dropped while the answer streams as a network failure', async () => {
    // What undici errors the body with when the socket closes mid-answer.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"hits":['));
        controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
      },
    });
    const { client } = ingress(() => new Response(body, { status: 200 }));
    await expect(call(client)).resolves.toMatchObject({ kind: 'network' });
  });

  // Only the call failing is a `ServiceCallError`. Anything else reported as "Restate is down"
  // would send an operator to the wrong place and the caller into retries.
  it('lets an error that is not the call failing through as it is', async () => {
    const bug = new RangeError('Maximum call stack size exceeded');
    const { client } = ingress(() => {
      throw bug;
    });
    await expect(call(client)).resolves.toBe(bug);
  });

  it('lets a request that JSON cannot encode fail as itself, not as an outage', async () => {
    const { client, fetchImpl } = ingress(() => json(200, {}));
    const error = await client
      .callService('RagQuery', 'search', { topK: 1n }, { timeoutMs: 1_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ServiceCallError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not mistake an answer that is not JSON for a network failure', async () => {
    const { client } = ingress(() => new Response('not json', { status: 200 }));
    await expect(call(client)).resolves.toMatchObject({ kind: 'ingress' });
  });
});

describe('the workflow methods', () => {
  it('still report ingress failures as before, in Restate’s own words', async () => {
    const { client } = ingress(() => json(404, { message: 'not found', source: 'ingress' }));
    const error = (await client
      .submitWorkflow('RagIngest', 'api_1', {})
      .catch((e: unknown) => e)) as PipelineError;
    expect(error).toMatchObject({
      code: 'RESTATE_INGRESS_ERROR',
      statusCode: 404,
      message: 'Restate ingress: not found',
    });
  });
});
