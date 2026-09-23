import type {
  DeploymentList,
  DeploymentRegistered,
  DeploymentRetired,
} from '@ai-pipeline/api-contract/deployments';
import type { StartRunAccepted } from '@ai-pipeline/api-contract/workflows';
import { afterAll, describe, expect, it } from 'vitest';
import { api, cli, compose, patchMetadata, restateSql, uniq, waitForRun } from './support.js';

const META = 'tests/fixtures/versioned-sleeper/metadata.json';

/** Immutable deployments: in-flight runs finish on the build they started on. */
describe('immutable deployments', () => {
  const tag = String(Date.now() % 1_000_000);
  const v1 = `1.0.${tag}`;
  const v2 = `2.0.${tag}`;
  const deployAs = (version: string) => {
    const restore = patchMetadata(META, (m) => {
      m.version = version;
      m.config.version = version;
    });
    try {
      return cli<DeploymentRegistered>('deploy', 'versioned-sleeper');
    } finally {
      restore();
    }
  };

  afterAll(async () => {
    // Retire every drained, non-active sleeper deployment so repeated runs don't pile up.
    const { body } = await api<DeploymentList>('GET', '/v1/deployments?name=versioned-sleeper');
    for (const d of body.deployments)
      if (d.status === 'draining' && d.inFlight === 0) cli('retire', d.deploymentId);
  });

  it('routes new runs to v2 while v1 drains, and retires v1 only once drained', async () => {
    const d1 = deployAs(v1);
    // Held on a durable promise: deterministic however long the v2 build takes.
    const long = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/versioned-sleeper/runs',
      { input: { seconds: 0, hold: true } },
      { 'idempotency-key': uniq() },
    );
    expect(long.status).toBe(202);
    await expect
      .poll(
        async () =>
          (
            await restateSql(
              `SELECT pinned_deployment_id AS d FROM sys_invocation WHERE id = '${long.body.invocationId}'`,
            )
          )[0]?.d,
        { timeout: 30_000 },
      )
      .toBe(d1.deploymentId);

    const d2 = deployAs(v2);
    expect(d2.deploymentId).not.toBe(d1.deploymentId);
    const quick = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/versioned-sleeper/runs',
      { input: { seconds: 1 } },
      { 'idempotency-key': uniq() },
    );

    const q = await waitForRun('versioned-sleeper', quick.body.runId, 60_000);
    expect(q).toMatchObject({
      status: 'completed',
      deploymentId: d2.deploymentId,
      output: { version: v2 },
    });

    expect(() => cli('retire', d1.deploymentId)).toThrow(/DEPLOYMENT_NOT_DRAINED/);

    // Resolve the durable promise through the (internal) ingress; v1 must finish the run.
    compose(
      'exec',
      '-T',
      'restate',
      'curl',
      '-sf',
      '-X',
      'POST',
      `http://localhost:8080/restate/call/VersionedSleeper/${long.body.runId}/release`,
    );
    const l = await waitForRun('versioned-sleeper', long.body.runId, 90_000);
    expect(l).toMatchObject({
      status: 'completed',
      deploymentId: d1.deploymentId,
      output: { version: v1 },
    });

    expect(cli<DeploymentRetired>('retire', d1.deploymentId)).toEqual({
      deploymentId: d1.deploymentId,
      status: 'retired',
    });
  });

  it('rejects re-registering a version from a different artifact', async () => {
    const v3 = `3.0.${tag}`;
    deployAs(v3);
    const restore = patchMetadata(META, (m) => {
      m.version = v3;
      m.config.version = v3;
      m.description = `${m.description} (changed)`; // same version, different artifact
    });
    try {
      expect(() => cli('deploy', 'versioned-sleeper')).toThrow(/VERSION_ARTIFACT_CONFLICT/);
    } finally {
      restore();
    }
  });
});
