import type { DeploymentView } from '@ai-pipeline/api-contract/deployments';
import { describe, expect, it } from 'vitest';
import type { CoreApi } from '../core-api.js';
import type { Docker } from '../docker.js';
import { retireDeployment } from './deployments.js';

/**
 * Retirement's Docker cleanup, which had no test at all.
 *
 * It is the one place in the CLI that removes a container it did not start, so the interesting cases
 * are all about *not* removing one: an endpoint another deployment still serves, and — the case this
 * file exists for — an endpoint claimed by a deploy that landed while the DELETE was in flight.
 */

const ENDPOINT = 'http://summary-abc123def456:9080';

const view = (over: Partial<DeploymentView> = {}): DeploymentView => ({
  deploymentId: 'dp_1',
  name: 'summary',
  version: '0.1.0',
  endpoint: ENDPOINT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  mode: 'immutable',
  status: 'draining',
  registeredAt: '2026-01-01T00:00:00.000Z',
  inFlight: 0,
  ...over,
});

interface Recorded {
  removedContainers: string[];
  removedImages: string[];
  lists: number;
}

function fakes(lists: DeploymentView[][]): {
  api: CoreApi;
  docker: Docker;
  recorded: Recorded;
} {
  const recorded: Recorded = { removedContainers: [], removedImages: [], lists: 0 };
  const api = (async (method: string, path: string) => {
    if (method === 'GET' && path.startsWith('/v1/deployments')) {
      // Each GET answers with the next snapshot, so a test can make the world change mid-retire.
      const snapshot = lists[Math.min(recorded.lists, lists.length - 1)]!;
      recorded.lists += 1;
      return { deployments: snapshot };
    }
    return { deploymentId: 'dp_1', status: 'retired' };
  }) as CoreApi;
  const docker: Docker = {
    imageExists: () => true,
    buildImage: () => undefined,
    removeImage: (tag) => recorded.removedImages.push(tag),
    containerState: () => 'running',
    containerLabel: () => undefined,
    containerImage: () => 'ai-pipeline/summary:0.1.0-abc123def456',
    runContainer: () => undefined,
    removeContainer: (name) => recorded.removedContainers.push(name),
  };
  return { api, docker, recorded };
}

describe('retireDeployment', () => {
  it('removes the container and reclaims the image when nothing else serves the endpoint', async () => {
    const { api, docker, recorded } = fakes([[view()]]);
    await expect(retireDeployment(api, docker, 'dp_1')).resolves.toEqual({
      deploymentId: 'dp_1',
      status: 'retired',
    });
    expect(recorded.removedContainers).toEqual(['summary-abc123def456']);
    expect(recorded.removedImages).toEqual(['ai-pipeline/summary:0.1.0-abc123def456']);
  });

  it('leaves the container alone when another live deployment shares the endpoint', async () => {
    const shared = [view(), view({ deploymentId: 'dp_2', status: 'active' })];
    const { api, docker, recorded } = fakes([shared]);
    await retireDeployment(api, docker, 'dp_1');
    expect(recorded.removedContainers).toEqual([]);
    expect(recorded.removedImages).toEqual([]);
  });

  it('leaves the container alone when a deploy claimed the endpoint during the retire', async () => {
    // The pre-retire snapshot shows dp_1 alone; by the time the DELETE returns, dp_2 is serving the
    // same endpoint. Deciding from the first snapshot would `rm -f` a runtime Restate routes to.
    const { api, docker, recorded } = fakes([
      [view()],
      [view({ status: 'retired' }), view({ deploymentId: 'dp_2', status: 'active' })],
    ]);
    await retireDeployment(api, docker, 'dp_1');
    expect(recorded.lists).toBe(2);
    expect(recorded.removedContainers).toEqual([]);
  });

  it('touches Docker not at all for an unknown or already-retired deployment', async () => {
    const unknown = fakes([[view({ deploymentId: 'dp_other' })]]);
    await retireDeployment(unknown.api, unknown.docker, 'dp_1');
    expect(unknown.recorded.removedContainers).toEqual([]);
    expect(unknown.recorded.lists).toBe(1);

    const gone = fakes([[view({ status: 'retired' })]]);
    await retireDeployment(gone.api, gone.docker, 'dp_1');
    expect(gone.recorded.removedContainers).toEqual([]);
    expect(gone.recorded.lists).toBe(1);
  });
});
