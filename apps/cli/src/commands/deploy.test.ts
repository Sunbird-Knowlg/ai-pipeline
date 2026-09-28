import {
  REGISTRATION_EVENT,
  type RegistrationOutcome,
} from '@ai-pipeline/api-contract/registration';
import { describe, expect, it } from 'vitest';
import type { DeploymentList, DeploymentView } from '@ai-pipeline/api-contract/deployments';
import type { CoreApi } from '../core-api.js';
import type { ContainerState, Docker, RunContainer } from '../docker.js';
import { deploy, latestOutcome } from './deploy.js';

/**
 * The parts of a deploy that are hard to get right: when a container is reused, when it is
 * recreated, how the unit's own registration outcome is read back, and — the one with teeth — when
 * this deploy is allowed to tear a container down again.
 *
 * The unit registers itself on boot; this command only reads the outcome from its logs. Tearing
 * down after core-api registered the endpoint would break invocations Restate is already routing
 * there, so the rule is "only a container this deploy started, and only for a failure that
 * happened before registration".
 */

const ROOT = process.cwd().replace(/\/apps\/cli$/, '');
const UNIT = 'summary';

interface Recorded {
  built: { tag: string; buildArgs: Record<string, string> | undefined }[];
  removedContainers: string[];
  removedImages: string[];
  started: RunContainer[];
  logReads: number;
}

/** A log line exactly as the runtime writes it: pino JSON with the outcome spread in. */
const line = (outcome: RegistrationOutcome): string =>
  JSON.stringify({ level: 30, service: UNIT, event: REGISTRATION_EVENT, ...outcome, msg: 'x' });

const registered: RegistrationOutcome = {
  outcome: 'registered',
  result: {
    name: UNIT,
    version: '9.9.9',
    deploymentId: 'dp_1',
    active: true,
    alreadyRegistered: false,
    triggers: [],
  },
};
const refused = (status: number, code: string): RegistrationOutcome => ({
  outcome: 'refused',
  status,
  code,
  message: `${code}: nope`,
});

function fakeDocker(
  state: {
    image?: boolean;
    container?: ContainerState;
    configLabel?: string;
    /** Successive `docker logs` snapshots; the last one repeats. */
    logs?: string[];
  } = {},
): Docker & { recorded: Recorded } {
  const recorded: Recorded = {
    built: [],
    removedContainers: [],
    removedImages: [],
    started: [],
    logReads: 0,
  };
  const logs = state.logs ?? [line(registered)];
  return {
    recorded,
    imageExists: () => state.image ?? false,
    buildImage: (_root, _pkg, tag, buildArgs) => recorded.built.push({ tag, buildArgs }),
    removeImage: (tag) => recorded.removedImages.push(tag),
    containerImage: () => 'ai-pipeline/unit:1.0.0-abc',
    containerState: () => state.container ?? 'missing',
    containerLabel: () => state.configLabel,
    runContainer: (options) => recorded.started.push(options),
    removeContainer: (name) => recorded.removedContainers.push(name),
    containerLogs: () => logs[Math.min(recorded.logReads++, logs.length - 1)]!,
  };
}

const deployment = (deploymentId: string, status: DeploymentView['status']): DeploymentView => ({
  deploymentId,
  name: UNIT,
  version: '9.9.9',
  endpoint: `http://${deploymentId}:9080`,
  artifactDigest: 'sha256:x',
  mode: 'immutable',
  status,
  registeredAt: '2026-09-28T00:00:00.000Z',
  inFlight: 0,
});

/** core-api's view of routing now; only consulted for a reused container. */
const catalogue =
  (...deployments: DeploymentView[]): CoreApi =>
  async <T>() =>
    ({ deployments }) satisfies DeploymentList as T;

const options = (
  docker: Docker & { recorded: Recorded },
  overrides: { dev?: boolean; log?: (line: string) => void; api?: CoreApi } = {},
) => ({
  root: ROOT,
  name: UNIT,
  dev: overrides.dev ?? false,
  network: 'ai-pipeline',
  env: { LITELLM_URL: 'http://litellm:4000', CORE_API_URL: 'http://core-api:3000' },
  api: overrides.api ?? catalogue(deployment('dp_1', 'active')),
  docker,
  log: overrides.log ?? (() => undefined),
  sleep: async () => undefined,
});

describe('deploy', () => {
  it('builds the image with its digest baked in, starts a container and returns its registration', async () => {
    const docker = fakeDocker();
    const result = await deploy(options(docker));

    expect(result).toMatchObject({ deploymentId: 'dp_1', active: true });
    expect(docker.recorded.built).toHaveLength(1);
    expect(docker.recorded.started).toHaveLength(1);

    const [container] = docker.recorded.started;
    // One container per artifact, labelled so a later deploy can tell whether it may be reused.
    expect(container!.name).toMatch(/^summary-[0-9a-f]{12}$/);
    expect(container!.labels).toMatchObject({ 'ai-pipeline.name': UNIT });
    const artifact = container!.labels['ai-pipeline.artifact'];
    expect(artifact).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The image, not the container, carries the digest: anything may start it.
    expect(docker.recorded.built[0]!.buildArgs).toEqual({ ARTIFACT_DIGEST: artifact });
    // What the runtime needs to register itself.
    expect(container!.env).toMatchObject({
      OTEL_SERVICE_NAME: UNIT,
      CORE_API_URL: 'http://core-api:3000',
      ADVERTISED_ENDPOINT: `http://${container!.name}:9080`,
      DEPLOYMENT_MODE: 'immutable',
    });
  });

  it('skips the build when the image already exists', async () => {
    const docker = fakeDocker({ image: true });
    await deploy(options(docker));
    expect(docker.recorded.built).toEqual([]);
  });

  it('reuses a running container with the same artifact and runtime config', async () => {
    // Discover the config label this deploy would compute, then replay it as already present.
    const probe = fakeDocker();
    await deploy(options(probe));
    const label = probe.recorded.started[0]!.labels['ai-pipeline.config'];

    // It registered when it booted, so its logs already hold the outcome.
    const docker = fakeDocker({ image: true, container: 'running', configLabel: label });
    await expect(deploy(options(docker))).resolves.toMatchObject({ deploymentId: 'dp_1' });
    expect(docker.recorded.started).toEqual([]);
    expect(docker.recorded.removedContainers).toEqual([]);
  });

  describe('a reused container', () => {
    const reused = async (api: CoreApi) => {
      const probe = fakeDocker();
      await deploy(options(probe));
      const label = probe.recorded.started[0]!.labels['ai-pipeline.config'];
      const docker = fakeDocker({ image: true, container: 'running', configLabel: label });
      return deploy(options(docker, { api }));
    };

    it('reports routing as it is now, not as it was when the container booted', async () => {
      // It booted as the active build; another endpoint has registered since.
      const result = await reused(
        catalogue(deployment('dp_1', 'draining'), deployment('dp_9', 'active')),
      );
      expect(result).toMatchObject({ deploymentId: 'dp_1', active: false });
      expect(result.note).toMatch(/draining; Restate routes new invocations to dp_9/);
    });

    it('refuses to report a deployment the catalogue no longer has', async () => {
      await expect(reused(catalogue(deployment('dp_1', 'retired')))).rejects.toThrow(
        /no longer live in the catalogue; restart its container/,
      );
    });
  });

  it('recreates a running container whose runtime config changed, and says so', async () => {
    const docker = fakeDocker({ image: true, container: 'running', configLabel: 'stale' });
    const lines: string[] = [];
    await deploy(options(docker, { log: (l) => lines.push(l) }));
    expect(docker.recorded.removedContainers).toHaveLength(1);
    expect(docker.recorded.started).toHaveLength(1);
    // Replacing a container Restate already routes to interrupts that endpoint; it must not be
    // something a deploy does quietly.
    expect(lines).toContainEqual(
      expect.stringMatching(/^! replacing container summary-[0-9a-f]{12}/),
    );
  });

  it('always recreates in dev mode, under a single reusable name', async () => {
    const docker = fakeDocker({ image: true, container: 'running', configLabel: 'whatever' });
    await deploy(options(docker, { dev: true }));
    const [container] = docker.recorded.started;
    expect(container!.name).toBe('summary-dev');
    expect(container!.env.DEPLOYMENT_MODE).toBe('dev');
  });

  describe('teardown on failure', () => {
    it('removes the container and image it created, for a pre-registration refusal', async () => {
      const docker = fakeDocker({ logs: [line(refused(409, 'VERSION_ARTIFACT_CONFLICT'))] });
      await expect(deploy(options(docker))).rejects.toThrow(/VERSION_ARTIFACT_CONFLICT/);

      expect(docker.recorded.removedContainers).toHaveLength(2); // one before start, one after
      expect(docker.recorded.removedImages).toHaveLength(1);
    });

    it('removes them when the runtime refused its own request', async () => {
      const docker = fakeDocker({
        logs: [
          line({ outcome: 'invalid', message: `a workflow's contract handler must be "run"` }),
        ],
      });
      await expect(deploy(options(docker))).rejects.toThrow(/must be "run"/);
      expect(docker.recorded.removedImages).toHaveLength(1);
    });

    it('keeps the container when the refusal came after registration', async () => {
      const docker = fakeDocker({ logs: [line(refused(409, 'ROUTING_UNKNOWN'))] });
      await expect(deploy(options(docker))).rejects.toThrow(/ROUTING_UNKNOWN/);
      // Restate may already route to this endpoint: removing it would break live invocations.
      expect(docker.recorded.removedImages).toEqual([]);
      expect(docker.recorded.removedContainers).toHaveLength(1); // only the pre-start cleanup
    });

    it('keeps the container when core-api could not be reached', async () => {
      const docker = fakeDocker({
        logs: [line({ outcome: 'failed', message: 'gave up registering after 20 attempts' })],
      });
      await expect(deploy(options(docker))).rejects.toThrow(/gave up/);
      expect(docker.recorded.removedImages).toEqual([]);
      expect(docker.recorded.removedContainers).toHaveLength(1);
    });

    it('never removes a container that existed before this deploy', async () => {
      const docker = fakeDocker({
        image: true,
        container: 'running',
        configLabel: 'stale',
        logs: [line(refused(409, 'VERSION_ARTIFACT_CONFLICT'))],
      });
      await expect(deploy(options(docker))).rejects.toThrow();
      expect(docker.recorded.removedContainers).toHaveLength(1); // only the pre-start cleanup
      expect(docker.recorded.removedImages).toEqual([]);
    });
  });

  describe('waiting', () => {
    it('polls the logs until the unit reports an outcome', async () => {
      const booting = JSON.stringify({ level: 30, msg: 'serving restate handlers' });
      const docker = fakeDocker({ logs: ['', booting, `${booting}\n${line(registered)}`] });
      await expect(deploy(options(docker))).resolves.toMatchObject({ deploymentId: 'dp_1' });
      expect(docker.recorded.logReads).toBe(3);
    });

    it('gives up rather than waiting forever, and leaves the container to be inspected', async () => {
      const docker = fakeDocker({ logs: [''] });
      await expect(deploy(options(docker))).rejects.toThrow(/logged no registration outcome/);
      expect(docker.recorded.removedImages).toEqual([]);
    });
  });

  it('refuses a unit the workspace does not contain', async () => {
    const docker = fakeDocker();
    await expect(deploy({ ...options(docker), name: 'not-a-unit' })).rejects.toThrow(
      /no deployable unit named "not-a-unit"/,
    );
    expect(docker.recorded.built).toEqual([]);
  });
});

describe('latestOutcome', () => {
  it('takes the last outcome, since a restarted container logs one per boot', () => {
    const logs = [line(refused(409, 'DEPENDENCY_NOT_DEPLOYED')), line(registered)].join('\n');
    expect(latestOutcome(logs)).toMatchObject({ outcome: 'registered' });
  });

  it('ignores lines that merely mention the event, or do not match the contract', () => {
    const logs = [
      `plain text mentioning ${REGISTRATION_EVENT}`,
      JSON.stringify({ event: REGISTRATION_EVENT, outcome: 'registered' }), // no result
      JSON.stringify({ msg: REGISTRATION_EVENT }),
    ].join('\n');
    expect(latestOutcome(logs)).toBeUndefined();
  });
});
