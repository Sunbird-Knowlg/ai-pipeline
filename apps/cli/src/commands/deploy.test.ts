import { describe, expect, it, vi } from 'vitest';
import { ApiError, type CoreApi } from '../core-api.js';
import type { ContainerState, Docker, RunContainer } from '../docker.js';
import { deploy } from './deploy.js';

/**
 * The parts of a deploy that are hard to get right and were untested: when a container is reused,
 * when it is recreated, when a refusal is retried, and — the one with teeth — when this deploy is
 * allowed to tear a container down again.
 *
 * Tearing down after Restate has registered the endpoint would break invocations Restate is already
 * routing there, so the rule is "only a container this deploy started, and only for a refusal that
 * happened before registration".
 */

const ROOT = process.cwd().replace(/\/apps\/cli$/, '');
const UNIT = 'summary';

interface Recorded {
  built: string[];
  removedContainers: string[];
  removedImages: string[];
  started: RunContainer[];
}

function fakeDocker(
  state: { image?: boolean; container?: ContainerState; configLabel?: string } = {},
): Docker & { recorded: Recorded } {
  const recorded: Recorded = { built: [], removedContainers: [], removedImages: [], started: [] };
  return {
    recorded,
    imageExists: () => state.image ?? false,
    buildImage: (_root, _pkg, tag) => recorded.built.push(tag),
    removeImage: (tag) => recorded.removedImages.push(tag),
    containerState: () => state.container ?? 'missing',
    containerLabel: () => state.configLabel,
    runContainer: (options) => recorded.started.push(options),
    removeContainer: (name) => recorded.removedContainers.push(name),
  };
}

const options = (
  api: CoreApi,
  docker: Docker & { recorded: Recorded },
  overrides: { dev?: boolean } = {},
) => ({
  root: ROOT,
  name: UNIT,
  dev: overrides.dev ?? false,
  network: 'ai-pipeline',
  env: { LITELLM_URL: 'http://litellm:4000' },
  api,
  docker,
  log: () => undefined,
  sleep: async () => undefined,
});

const accepted: CoreApi = async () =>
  ({
    name: UNIT,
    version: '9.9.9',
    deploymentId: 'dp_1',
    active: true,
    triggers: [],
  }) as never;

const refusing = (status: number, code: string): CoreApi => {
  return async () => {
    throw new ApiError(status, code, `${code}: nope`);
  };
};

describe('deploy', () => {
  it('builds the image, starts a container and registers it', async () => {
    const docker = fakeDocker();
    const result = await deploy(options(accepted, docker));

    expect(result).toMatchObject({ deploymentId: 'dp_1', active: true });
    expect(docker.recorded.built).toHaveLength(1);
    expect(docker.recorded.started).toHaveLength(1);

    const [container] = docker.recorded.started;
    // One container per artifact, labelled so a later deploy can tell whether it may be reused.
    expect(container!.name).toMatch(/^summary-[0-9a-f]{12}$/);
    expect(container!.labels).toMatchObject({ 'ai-pipeline.name': UNIT });
    expect(container!.labels['ai-pipeline.artifact']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(container!.env.OTEL_SERVICE_NAME).toBe(UNIT);
  });

  it('skips the build when the image already exists', async () => {
    const docker = fakeDocker({ image: true });
    await deploy(options(accepted, docker));
    expect(docker.recorded.built).toEqual([]);
  });

  it('reuses a running container with the same artifact and runtime config', async () => {
    // Discover the config label this deploy would compute, then replay it as already present.
    const probe = fakeDocker();
    await deploy(options(accepted, probe));
    const label = probe.recorded.started[0]!.labels['ai-pipeline.config'];

    const docker = fakeDocker({ image: true, container: 'running', configLabel: label });
    await deploy(options(accepted, docker));
    expect(docker.recorded.started).toEqual([]);
    expect(docker.recorded.removedContainers).toEqual([]);
  });

  it('recreates a running container whose runtime config changed', async () => {
    const docker = fakeDocker({ image: true, container: 'running', configLabel: 'stale' });
    await deploy(options(accepted, docker));
    expect(docker.recorded.removedContainers).toHaveLength(1);
    expect(docker.recorded.started).toHaveLength(1);
  });

  it('always recreates in dev mode, under a single reusable name', async () => {
    const docker = fakeDocker({ image: true, container: 'running', configLabel: 'whatever' });
    await deploy(options(accepted, docker, { dev: true }));
    expect(docker.recorded.started[0]!.name).toBe('summary-dev');
  });

  describe('teardown on refusal', () => {
    it('removes the container and image it created, for a pre-registration refusal', async () => {
      const docker = fakeDocker();
      await expect(
        deploy(options(refusing(409, 'VERSION_ARTIFACT_CONFLICT'), docker)),
      ).rejects.toThrow(/VERSION_ARTIFACT_CONFLICT/);

      expect(docker.recorded.removedContainers).toHaveLength(2); // one before start, one after
      expect(docker.recorded.removedImages).toHaveLength(1);
    });

    it('keeps the container when the refusal came after registration', async () => {
      const docker = fakeDocker();
      await expect(deploy(options(refusing(409, 'ROUTING_UNKNOWN'), docker))).rejects.toThrow();
      // Restate may already route to this endpoint: removing it would break live invocations.
      expect(docker.recorded.removedImages).toEqual([]);
      expect(docker.recorded.removedContainers).toHaveLength(1); // only the pre-start cleanup
    });

    it('never removes a container that existed before this deploy', async () => {
      const docker = fakeDocker({ image: true, container: 'running', configLabel: 'stale' });
      await expect(
        deploy(options(refusing(409, 'VERSION_ARTIFACT_CONFLICT'), docker)),
      ).rejects.toThrow();
      expect(docker.recorded.removedContainers).toHaveLength(1); // only the pre-start cleanup
      expect(docker.recorded.removedImages).toEqual([]);
    });
  });

  describe('retries', () => {
    it('retries while the endpoint is still coming up, then succeeds', async () => {
      const api = vi.fn<CoreApi>();
      api
        .mockRejectedValueOnce(new ApiError(502, 'RESTATE_UNAVAILABLE', 'not yet'))
        .mockRejectedValueOnce(new ApiError(503, 'CATALOGUE_SYNC_FAILED', 'retry'))
        .mockResolvedValueOnce({
          name: UNIT,
          version: '9.9.9',
          deploymentId: 'dp_2',
          active: true,
          triggers: [],
        });

      const docker = fakeDocker();
      await expect(deploy(options(api as CoreApi, docker))).resolves.toMatchObject({
        deploymentId: 'dp_2',
      });
      expect(api).toHaveBeenCalledTimes(3);
    });

    it('does not retry a refusal that will not change', async () => {
      const api = vi
        .fn<CoreApi>()
        .mockRejectedValue(new ApiError(409, 'DEPENDENCY_NOT_DEPLOYED', 'x'));
      await expect(deploy(options(api as CoreApi, fakeDocker()))).rejects.toThrow();
      expect(api).toHaveBeenCalledOnce();
    });

    it('gives up after the attempt limit rather than spinning forever', async () => {
      const api = vi.fn<CoreApi>().mockRejectedValue(new ApiError(502, 'RESTATE_UNAVAILABLE', 'x'));
      await expect(deploy(options(api as CoreApi, fakeDocker()))).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(20);
    });
  });

  it('refuses a unit the workspace does not contain', async () => {
    const docker = fakeDocker();
    await expect(deploy({ ...options(accepted, docker), name: 'not-a-unit' })).rejects.toThrow(
      /no deployable unit named "not-a-unit"/,
    );
    expect(docker.recorded.built).toEqual([]);
  });
});
