import { describe, expect, it } from 'vitest';
import { type PipelineError } from '../errors.js';
import { definitionOf, deploymentOf, fakeControlPlane } from '../testing/restate.js';
import { retireDeployment } from './retirement.js';

/**
 * Retirement refusals. Getting one of these wrong removes a deployment that Restate still needs,
 * which breaks either new invocations or runs already mid-journal — so each one has a test.
 */
describe('retireDeployment', () => {
  const seeded = (deployments: ReturnType<typeof deploymentOf>[]) =>
    fakeControlPlane({ seed: { definitions: [definitionOf()], deployments } });

  it('retires a drained, non-routed deployment and removes it from Restate', async () => {
    const cp = seeded([
      deploymentOf({ deploymentId: 'dp_1', status: 'active' }),
      deploymentOf({ deploymentId: 'dp_0', status: 'draining' }),
    ]);
    cp.admin.routing.set('ContentEnrichment', 'dp_1');
    cp.admin.rows = [{ n: 0 }];

    await expect(retireDeployment(cp, 'dp_0')).resolves.toEqual({
      deploymentId: 'dp_0',
      status: 'retired',
    });
    expect(cp.admin.deleted).toEqual(['dp_0']);
    expect(cp.store.seed.deployments.find((d) => d.deploymentId === 'dp_0')?.status).toBe(
      'retired',
    );
  });

  it('is idempotent once retired, without calling Restate again', async () => {
    const cp = seeded([deploymentOf({ deploymentId: 'dp_0', status: 'retired' })]);
    await expect(retireDeployment(cp, 'dp_0')).resolves.toEqual({
      deploymentId: 'dp_0',
      status: 'retired',
    });
    expect(cp.admin.deleted).toEqual([]);
  });

  it('404s on an unknown deployment', async () => {
    const cp = seeded([]);
    await expect(retireDeployment(cp, 'dp_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses the deployment the catalogue marks active', async () => {
    const cp = seeded([deploymentOf({ deploymentId: 'dp_1', status: 'active' })]);
    const error = (await retireDeployment(cp, 'dp_1').catch((e: unknown) => e)) as PipelineError;
    expect(error).toMatchObject({ code: 'DEPLOYMENT_ACTIVE', statusCode: 409 });
    expect(cp.admin.deleted).toEqual([]);
  });

  it('refuses a deployment Restate still routes to, even when the catalogue disagrees', async () => {
    // The catalogue says draining, Restate says it is still the target. Restate wins.
    const cp = seeded([deploymentOf({ deploymentId: 'dp_0', status: 'draining' })]);
    cp.admin.routing.set('ContentEnrichment', 'dp_0');
    cp.admin.rows = [{ n: 0 }];

    await expect(retireDeployment(cp, 'dp_0')).rejects.toMatchObject({ code: 'DEPLOYMENT_ACTIVE' });
    expect(cp.admin.deleted).toEqual([]);
  });

  it('refuses while invocations are still pinned to it', async () => {
    const cp = seeded([
      deploymentOf({ deploymentId: 'dp_1', status: 'active' }),
      deploymentOf({ deploymentId: 'dp_0', status: 'draining' }),
    ]);
    cp.admin.routing.set('ContentEnrichment', 'dp_1');
    cp.admin.rows = [{ n: 3 }];

    const error = (await retireDeployment(cp, 'dp_0').catch((e: unknown) => e)) as PipelineError;
    expect(error).toMatchObject({ code: 'DEPLOYMENT_NOT_DRAINED', statusCode: 409 });
    expect(error.message).toContain('3 invocation(s)');
    expect(cp.admin.deleted).toEqual([]);
  });
});
