import { createHash } from 'node:crypto';
import type { DeploymentRegistered } from '@ai-pipeline/api-contract/deployments';
import { PRE_REGISTRATION_CODES, type PipelineErrorCode } from '@ai-pipeline/api-contract/errors';
import {
  REGISTRATION_EVENT,
  registrationOutcome,
  type RegistrationOutcome,
} from '@ai-pipeline/api-contract/registration';
import { canonicalJson } from '@ai-pipeline/contracts/schemas';
import { sourceDigest } from '../artifact.js';
import { ApiError, type CoreApi } from '../core-api.js';
import type { Docker } from '../docker.js';
import { findUnit, type Unit } from '../units.js';
import { listDeployments } from './deployments.js';

/**
 * `pipeline deploy`: build the image → start one container per artifact (`--dev` reuses
 * `<name>-dev`) → wait for the unit to register itself. The runtime posts `POST /v1/deployments` on
 * boot (`@ai-pipeline/runtime/serve`), where core-api registers it with Restate, updates the
 * catalogue and reconciles triggers; this command reads the outcome back from the container's logs.
 */
export interface DeployOptions {
  root: string;
  name: string;
  dev: boolean;
  network: string;
  /** The unit's runtime environment, including the `CORE_API_URL` it registers with. */
  env: Record<string, string>;
  /** Read-only here: asks core-api where routing stands when a container is reused. */
  api: CoreApi;
  docker: Docker;
  log: (line: string) => void;
  /** Injected so tests need not actually wait between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 1000;
/** Longer than the runtime's own retry budget, so a slow core-api is reported by the runtime. */
const WAIT_MS = 150_000;

export async function deploy(o: DeployOptions): Promise<DeploymentRegistered> {
  const unit = findUnit(o.root, o.name);

  const artifact = sourceDigest(o.root, unit.packageName);
  const digest = artifact.replace(/^sha256:/, '').slice(0, 12);
  const image = `ai-pipeline/${unit.metadata.name}:${unit.metadata.version}-${digest}`;
  const builtHere = !o.docker.imageExists(image);
  if (builtHere) {
    o.log(`▸ building ${image}`);
    // Baked in, not passed at run time: the image does not carry the source the digest covers, and
    // a container started by anything other than this CLI must still register the right artifact.
    o.docker.buildImage(o.root, unit.packageName, image, { ARTIFACT_DIGEST: artifact });
  } else o.log(`▸ image ${image} is up to date`);

  const container = o.dev ? `${unit.metadata.name}-dev` : `${unit.metadata.name}-${digest}`;
  const { startedHere } = ensureContainer(o, unit, { container, image, artifact });

  return awaitRegistration(o, { container, image, builtHere, startedHere });
}

/**
 * Reuses a running container when both the artifact and the runtime config match, so that the
 * endpoint — and therefore the Restate deployment — is unchanged. Anything else is recreated under
 * the same name.
 */
function ensureContainer(
  o: DeployOptions,
  unit: Unit,
  target: { container: string; image: string; artifact: string },
): { startedHere: boolean } {
  const env = {
    ...o.env,
    OTEL_SERVICE_NAME: unit.metadata.name,
    ADVERTISED_ENDPOINT: `http://${target.container}:9080`,
    DEPLOYMENT_MODE: o.dev ? 'dev' : 'immutable',
  };
  const config = createHash('sha256')
    .update(canonicalJson({ image: target.image, env, network: o.network }))
    .digest('hex')
    .slice(0, 16);

  const state = o.docker.containerState(target.container);
  const reusable =
    !o.dev &&
    state === 'running' &&
    o.docker.containerLabel(target.container, 'ai-pipeline.config') === config;
  // Only a container that did not exist before this deploy may be torn down again on a refusal.
  const startedHere = state === 'missing';

  if (reusable) {
    o.log(`▸ container ${target.container} already running (same artifact and config)`);
    return { startedHere };
  }
  // In immutable mode the container name is the artifact, so getting here with a container already
  // in place means the same code with different env or network. Docker cannot swap that in place, so
  // the endpoint goes away until the replacement is serving, and invocations pinned to it retry
  // meanwhile (and pause if the replacement never comes up). Worth saying out loud; in production
  // this is a Deployment's rollout, not ours — see docs/decisions.md.
  if (!o.dev && !startedHere)
    o.log(
      `! replacing container ${target.container}: same artifact, different runtime config. The endpoint is down until the replacement serves, and invocations pinned to it will retry.`,
    );
  o.docker.removeContainer(target.container);
  o.log(`▸ starting container ${target.container}`);
  o.docker.runContainer({
    name: target.container,
    image: target.image,
    network: o.network,
    env,
    labels: {
      'ai-pipeline.name': unit.metadata.name,
      'ai-pipeline.version': unit.metadata.version,
      'ai-pipeline.artifact': target.artifact,
      'ai-pipeline.config': config,
    },
  });
  return { startedHere };
}

/**
 * Waits for the unit's own registration outcome (see `@ai-pipeline/api-contract/registration`).
 *
 * The latest outcome wins: a container that exits after a refusal is restarted by Docker and logs
 * another. A container reused from an earlier deploy already logged its outcome when it booted.
 */
async function awaitRegistration(
  o: DeployOptions,
  target: { container: string; image: string; builtHere: boolean; startedHere: boolean },
): Promise<DeploymentRegistered> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  o.log(`▸ waiting for ${target.container} to register`);
  for (let waited = 0; ; waited += POLL_MS) {
    const outcome = latestOutcome(o.docker.containerLogs(target.container));
    if (outcome?.outcome === 'registered') {
      const result = target.startedHere ? outcome.result : await current(o, outcome.result);
      const already = result.alreadyRegistered ? ', already registered' : '';
      o.log(
        `✔ ${result.name}@${result.version} → ${result.deploymentId} (${target.container}${already})`,
      );
      return result;
    }
    if (outcome) {
      const error =
        outcome.outcome === 'refused'
          ? new ApiError(outcome.status, outcome.code, outcome.message)
          : new Error(outcome.message);
      tearDownOrWarn(o, target, beforeRegistration(outcome));
      throw error;
    }
    if (waited >= WAIT_MS) {
      tearDownOrWarn(o, target, false);
      throw new Error(
        `${target.container} logged no registration outcome in ${WAIT_MS / 1000}s; see \`docker logs ${target.container}\``,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * A container this deploy did not start logged its outcome when it booted, and routing may have
 * moved since — another build registered after it, or it was retired. Its `active` is re-read from
 * the catalogue rather than repeated from an old log line.
 */
async function current(
  o: DeployOptions,
  booted: DeploymentRegistered,
): Promise<DeploymentRegistered> {
  const { deployments } = await listDeployments(o.api, booted.name);
  const now = deployments.find((d) => d.deploymentId === booted.deploymentId);
  if (!now || now.status === 'retired')
    throw new Error(
      `${booted.deploymentId} is no longer live in the catalogue; restart its container to register it again`,
    );
  const { note: _stale, ...rest } = booted;
  if (now.status === 'active') return { ...rest, active: true };
  const routed = deployments.find((d) => d.status === 'active');
  return {
    ...rest,
    active: false,
    note: `this deployment is ${now.status}; Restate routes new invocations to ${routed?.deploymentId ?? 'another deployment'}. Deploy a new build to roll forward.`,
  };
}

/**
 * Only a container this deploy started, and only for a failure that happened before core-api
 * registered the endpoint, may be removed: afterwards Restate may already route invocations to it.
 */
function tearDownOrWarn(
  o: DeployOptions,
  target: { container: string; image: string; builtHere: boolean; startedHere: boolean },
  preRegistration: boolean,
): void {
  if (!target.startedHere) return;
  if (preRegistration) {
    o.docker.removeContainer(target.container);
    if (target.builtHere) o.docker.removeImage(target.image);
    return;
  }
  // Anything else may have registered the endpoint before failing — a 503 from the catalogue sync
  // certainly did, and an unreachable core-api cannot be distinguished from one. The container
  // keeps retrying on restart; the operator is told rather than left to find it.
  o.log(
    `▸ ${target.container} is still running and may be registered; re-run the deploy to retry, ` +
      `or \`docker rm -f ${target.container}\` once you have checked \`pipeline deployments\``,
  );
}

/** Whether nothing can have been registered. The code list is part of the wire contract. */
const beforeRegistration = (outcome: RegistrationOutcome): boolean =>
  outcome.outcome === 'invalid' ||
  (outcome.outcome === 'refused' &&
    PRE_REGISTRATION_CODES.includes(outcome.code as PipelineErrorCode));

/** The last registration outcome in a container's logs, if it has logged one yet. */
export function latestOutcome(logs: string): RegistrationOutcome | undefined {
  let latest: RegistrationOutcome | undefined;
  for (const line of logs.split('\n')) {
    if (!line.includes(REGISTRATION_EVENT)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if ((parsed as { event?: unknown }).event !== REGISTRATION_EVENT) continue;
    const outcome = registrationOutcome.safeParse(parsed);
    if (outcome.success) latest = outcome.data;
  }
  return latest;
}
