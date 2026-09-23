import { describe, expect, it, vi } from 'vitest';
import type { PipelineError } from '../errors.js';
import { RestateAdmin } from './admin.js';

/**
 * How Restate's admin API failures reach a caller.
 *
 * The distinction matters operationally: `RESTATE_UNAVAILABLE` means "Restate did not answer, try
 * again", `RESTATE_ADMIN_ERROR` means "Restate answered and refused". The deploy CLI retries 502/503
 * responses, so mapping one as the other would either spin forever or give up too early.
 */
function admin(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) =>
    respond(String(input), init),
  );
  return {
    client: new RestateAdmin('http://restate:9070', fetchImpl),
    fetchImpl,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('failure mapping', () => {
  it('maps a network failure to a retryable RESTATE_UNAVAILABLE', async () => {
    const { client } = admin(() => {
      throw new Error('ECONNREFUSED');
    });
    const error = (await client.listSubscriptions().catch((e: unknown) => e)) as PipelineError;
    expect(error).toMatchObject({ code: 'RESTATE_UNAVAILABLE', statusCode: 502 });
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('maps a refusal to RESTATE_ADMIN_ERROR and keeps Restate’s own message', async () => {
    const { client } = admin(() => json(400, { message: 'invalid subscription sink' }));
    const error = (await client.listSubscriptions().catch((e: unknown) => e)) as PipelineError;
    expect(error).toMatchObject({ code: 'RESTATE_ADMIN_ERROR', statusCode: 502 });
    expect(error.message).toContain('invalid subscription sink');
  });

  it('survives a non-JSON error body', async () => {
    const { client } = admin(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const error = (await client.listSubscriptions().catch((e: unknown) => e)) as PipelineError;
    expect(error.code).toBe('RESTATE_ADMIN_ERROR');
    expect(error.message).toContain('502 Bad Gateway');
  });

  it('reports health as false instead of throwing', async () => {
    const { client } = admin(() => {
      throw new Error('down');
    });
    await expect(client.health()).resolves.toBe(false);
  });
});

describe('expected non-2xx responses', () => {
  it('treats a 409 from the Kafka cluster as "already exists"', async () => {
    const { client, fetchImpl } = admin(() => json(409, { message: 'already exists' }));
    await expect(client.ensureKafkaCluster('local', 'kafka:9092')).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reads an unknown service as undefined, not as an error', async () => {
    const { client } = admin(() => json(404, { message: 'not found' }));
    await expect(client.service('Nope')).resolves.toBeUndefined();
    await expect(client.serviceExists('Nope')).resolves.toBe(false);
  });

  it('reports the routed deployment of a known service', async () => {
    const { client } = admin(() => json(200, { deployment_id: 'dp_7', revision: 3 }));
    await expect(client.service('ContentEnrichment')).resolves.toEqual({
      deployment_id: 'dp_7',
      revision: 3,
    });
  });

  it('distinguishes the three cancellation outcomes by status code', async () => {
    const outcomes = [
      [202, 'requested'],
      [404, 'not_found'],
      [409, 'completed'],
    ] as const;
    for (const [status, expected] of outcomes) {
      const { client } = admin(() => new Response(null, { status }));
      await expect(client.cancelInvocation('inv_1')).resolves.toBe(expected);
    }
  });

  it('tolerates a deployment that is already gone', async () => {
    const { client } = admin(() => new Response(null, { status: 404 }));
    await expect(client.deleteDeployment('dp_1')).resolves.toBeUndefined();
  });
});

describe('request shape', () => {
  it('asks Restate to discover without registering when probing an endpoint', async () => {
    const { client, fetchImpl } = admin(() => json(200, { id: 'dp_1', services: [] }));
    await client.dryRunDeployment('http://unit:9080', false);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      uri: 'http://unit:9080',
      force: false,
      dry_run: true,
    });
  });

  it('percent-encodes ids it puts in a path', async () => {
    const { client, fetchImpl } = admin(() => new Response(null, { status: 204 }));
    await client.deleteSubscription('sub/with slash');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('sub%2Fwith%20slash');
  });
});
