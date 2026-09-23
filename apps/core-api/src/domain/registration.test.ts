import type { DeploymentRequest } from '@ai-pipeline/api-contract/deployments';
import { PRE_REGISTRATION_CODES } from '@ai-pipeline/api-contract/errors';
import { describe, expect, it } from 'vitest';
import { PipelineError } from '../errors.js';
import {
  definitionOf,
  deploymentOf,
  fakeControlPlane,
  metadataOf,
  type FakeAdmin,
} from '../testing/restate.js';
import { registerDeployment } from './registration.js';

/**
 * The registration state machine: 344 lines of control-plane rules that had no tests at all.
 *
 * The ordering property matters as much as the individual refusals — see `PRE_REGISTRATION_CODES`,
 * which the deploy CLI uses to decide whether it may tear the container down again.
 */

const ENDPOINT = 'http://content-enrichment-abc123:9080';

function request(overrides: Partial<DeploymentRequest> = {}): DeploymentRequest {
  return {
    metadata: metadataOf({ triggers: [{ id: 'api', type: 'rest' }] }),
    schemas: {
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { type: 'object' },
      config: { type: 'object' },
    },
    contractHash: `sha256:${'a'.repeat(64)}`,
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    endpoint: ENDPOINT,
    mode: 'immutable',
    ...overrides,
  };
}

/** A Restate that serves the workflow at the endpoint, as a healthy deploy would. */
function serving(admin: FakeAdmin, names = ['ContentEnrichment']): FakeAdmin {
  admin.served.set(ENDPOINT, names);
  return admin;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    if (error instanceof PipelineError) return error.code;
    throw error;
  }
}

describe('registerDeployment', () => {
  it('registers a first build, marks it active and syncs its triggers', async () => {
    const cp = fakeControlPlane();
    serving(cp.admin);

    const result = await registerDeployment(cp, request());

    expect(result).toMatchObject({
      name: 'content-enrichment',
      version: '1.0.0',
      deploymentId: 'dp_1',
      active: true,
    });
    expect(result.note).toBeUndefined();
    expect(cp.store.seed.definitions).toHaveLength(1);
    expect(cp.store.seed.deployments[0]).toMatchObject({ deploymentId: 'dp_1', status: 'active' });
    expect(result.triggers).toEqual([
      expect.objectContaining({ id: 'api', type: 'rest', desiredEnabled: true }),
    ]);
  });

  it('takes both locks it needs in one section, and never nests them', async () => {
    // Nesting is the bug this asserts against, not a style point: a second `withLock` inside the
    // first checks out a second pooled connection while this request still holds one, so a handful
    // of concurrent deploys exhaust the pool and every one of them times out.
    const cp = fakeControlPlane();
    serving(cp.admin);
    await registerDeployment(cp, request());

    expect(cp.store.locks).toEqual(['register:content-enrichment', 'reconcile:content-enrichment']);
    expect(cp.store.maxNestedLocks).toBe(1);
  });

  it('really does serialise two concurrent registrations of the same unit', async () => {
    // The lock is what stops two reconciles each creating a subscription, so run two at once and
    // assert the sections did not interleave.
    const cp = fakeControlPlane();
    serving(cp.admin);
    const order: string[] = [];
    const store = cp.store;
    let inside = 0;
    cp.store = {
      ...store,
      withLock: (keys, fn) =>
        store.withLock(keys, async (locked) => {
          inside += 1;
          order.push(`enter:${inside}`);
          await new Promise((resolve) => setImmediate(resolve));
          const result = await fn(locked);
          order.push(`exit:${inside}`);
          inside -= 1;
          return result;
        }),
    };

    const both = await Promise.all([
      registerDeployment(cp, request()),
      registerDeployment(cp, request()),
    ]);
    // Each section ran to completion before the next began — never `enter, enter, exit, exit`.
    expect(order).toEqual(['enter:1', 'exit:1', 'enter:1', 'exit:1']);
    expect(both.every((r) => r.name === 'content-enrichment')).toBe(true);
  });

  it('refuses before touching Restate, and only with pre-registration codes', async () => {
    const cases: { what: string; run: () => Promise<unknown>; code: string }[] = [
      {
        what: 'metadata that does not parse',
        run: () => {
          const cp = fakeControlPlane();
          return registerDeployment(cp, request({ metadata: { kind: 'nonsense' } }));
        },
        code: 'INVALID_METADATA',
      },
      {
        what: 'a schema Ajv cannot compile',
        run: () => {
          const cp = fakeControlPlane();
          return registerDeployment(
            cp,
            request({
              schemas: { input: { type: 'not-a-type' }, output: {}, config: {} },
            }),
          );
        },
        code: 'INVALID_SCHEMA',
      },
      {
        what: 'config that does not match its schema',
        run: () => {
          const cp = fakeControlPlane();
          return registerDeployment(
            cp,
            request({
              metadata: metadataOf({ config: { summaryMaxWords: 'lots' } }),
              schemas: {
                input: { type: 'object' },
                output: { type: 'object' },
                config: {
                  type: 'object',
                  properties: { summaryMaxWords: { type: 'integer' } },
                  required: ['summaryMaxWords'],
                },
              },
            }),
          );
        },
        code: 'INVALID_CONFIG',
      },
      {
        what: 'a Restate name another unit already owns',
        run: () => {
          const cp = fakeControlPlane({
            seed: {
              definitions: [
                definitionOf({
                  metadata: metadataOf({ name: 'other-unit', restateName: 'ContentEnrichment' }),
                  name: 'other-unit',
                }),
              ],
            },
          });
          return registerDeployment(cp, request());
        },
        code: 'RESTATE_NAME_TAKEN',
      },
      {
        what: 'a dependency that is not in the catalogue',
        run: () => {
          const cp = fakeControlPlane();
          serving(cp.admin);
          return registerDeployment(
            cp,
            request({
              metadata: metadataOf({ dependencies: [{ kind: 'service', name: 'summary' }] }),
            }),
          );
        },
        code: 'DEPENDENCY_NOT_REGISTERED',
      },
      {
        what: 'a dependency the catalogue knows but Restate does not serve',
        run: () => {
          const cp = fakeControlPlane({
            seed: {
              definitions: [
                definitionOf({
                  metadata: metadataOf({
                    name: 'summary',
                    kind: 'service',
                    restateName: 'SummaryService',
                  }),
                  name: 'summary',
                }),
              ],
            },
          });
          serving(cp.admin);
          return registerDeployment(
            cp,
            request({
              metadata: metadataOf({ dependencies: [{ kind: 'service', name: 'summary' }] }),
            }),
          );
        },
        code: 'DEPENDENCY_NOT_DEPLOYED',
      },
      {
        what: 'an endpoint serving something else',
        run: () => {
          const cp = fakeControlPlane();
          serving(cp.admin, ['SomethingElse']);
          return registerDeployment(cp, request());
        },
        code: 'SERVICE_MISMATCH',
      },
    ];

    for (const { what, run, code } of cases) {
      expect(await codeOf(run()), what).toBe(code);
      expect(PRE_REGISTRATION_CODES, `${what} must be safe to tear down`).toContain(code);
    }
  });

  it('accepts the endpoint when it also serves the unit’s own trigger service', async () => {
    const cp = fakeControlPlane();
    serving(cp.admin, ['ContentEnrichment', 'ContentEnrichmentTrigger']);
    await expect(registerDeployment(cp, request())).resolves.toMatchObject({ active: true });
  });

  it('never registers with Restate once a refusal has happened', async () => {
    const cp = fakeControlPlane();
    serving(cp.admin, ['SomethingElse']);
    await expect(registerDeployment(cp, request())).rejects.toThrow();
    expect(cp.store.seed.deployments).toHaveLength(0);
    expect(cp.store.seed.definitions).toHaveLength(0);
  });

  describe('version rule', () => {
    const seeded = () =>
      fakeControlPlane({
        seed: {
          definitions: [definitionOf()],
          deployments: [deploymentOf({ artifactDigest: `sha256:${'b'.repeat(64)}` })],
        },
      });

    it('is idempotent for the same version, contract and artifact', async () => {
      const cp = seeded();
      serving(cp.admin);
      // Restate returns the same deployment id for an unchanged endpoint, so it stays the routed one.
      cp.admin.routing.set('ContentEnrichment', 'dp_1');
      await expect(registerDeployment(cp, request())).resolves.toMatchObject({
        deploymentId: 'dp_1',
        active: true,
      });
      expect(cp.store.seed.definitions).toHaveLength(1);
    });

    it('refuses the same version with a different contract', async () => {
      const cp = seeded();
      serving(cp.admin);
      expect(
        await codeOf(registerDeployment(cp, request({ contractHash: `sha256:${'c'.repeat(64)}` }))),
      ).toBe('VERSION_CONTRACT_CONFLICT');
    });

    it('refuses the same version built from a different artifact', async () => {
      const cp = seeded();
      serving(cp.admin);
      expect(
        await codeOf(
          registerDeployment(cp, request({ artifactDigest: `sha256:${'d'.repeat(64)}` })),
        ),
      ).toBe('VERSION_ARTIFACT_CONFLICT');
    });

    it('lets dev mode replace a version in place', async () => {
      const cp = seeded();
      serving(cp.admin);
      await expect(
        registerDeployment(
          cp,
          request({ mode: 'dev', artifactDigest: `sha256:${'d'.repeat(64)}` }),
        ),
      ).resolves.toMatchObject({ name: 'content-enrichment' });
    });
  });

  describe('routing', () => {
    it('reports the routed deployment rather than assuming the new one won', async () => {
      const cp = fakeControlPlane({
        seed: {
          definitions: [definitionOf()],
          deployments: [deploymentOf({ deploymentId: 'dp_9' })],
        },
      });
      serving(cp.admin);
      // Restate keeps routing to the older deployment: re-registering an unchanged endpoint does
      // not move routing back to it.
      cp.admin.routing.set('ContentEnrichment', 'dp_9');

      const result = await registerDeployment(cp, request());
      expect(result.active).toBe(false);
      expect(result.note).toMatch(/still routes new invocations to dp_9/);
      expect(cp.store.seed.deployments.find((d) => d.deploymentId === 'dp_9')?.status).toBe(
        'active',
      );
    });

    it('reports a catalogue-sync failure as retryable, because every later step is idempotent', async () => {
      const cp = fakeControlPlane();
      serving(cp.admin);
      // Restate says it routes to a deployment the catalogue has never heard of.
      cp.admin.routing.set('ContentEnrichment', 'dp_unknown');

      const error = await registerDeployment(cp, request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).code).toBe('ROUTING_UNKNOWN');
      expect((error as PipelineError).statusCode).toBe(409);
    });
  });

  it('syncs triggers only from a build that becomes the routed one', async () => {
    const cp = fakeControlPlane({
      seed: {
        definitions: [definitionOf()],
        deployments: [deploymentOf({ deploymentId: 'dp_9' })],
      },
    });
    serving(cp.admin);
    cp.admin.routing.set('ContentEnrichment', 'dp_9');

    await registerDeployment(
      cp,
      request({ metadata: metadataOf({ triggers: [{ id: 'api', type: 'rest' }] }) }),
    );
    // The older build stays routed, so its trigger set is left alone.
    expect(cp.store.seed.triggers).toHaveLength(0);
  });
});
