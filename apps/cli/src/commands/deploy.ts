import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DeploymentRegistered,
  DeploymentRequest,
} from '@ai-pipeline/api-contract/deployments';
import { PRE_REGISTRATION_CODES, type PipelineErrorCode } from '@ai-pipeline/api-contract/errors';
import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { canonicalJson, contractHash, contractSchemas } from '@ai-pipeline/contracts/schemas';
import { sourceDigest } from '../artifact.js';
import { ApiError, type CoreApi } from '../core-api.js';
import type { Docker } from '../docker.js';
import { findUnit, type Unit } from '../units.js';

/**
 * `pipeline deploy`: build the image → start one container per artifact (`--dev` reuses
 * `<name>-dev`) → `POST /v1/deployments`, where core-api registers it with Restate, updates the
 * catalogue and reconciles triggers. The runtime process itself never registers anything.
 */
export interface DeployOptions {
  root: string;
  name: string;
  dev: boolean;
  network: string;
  env: Record<string, string>;
  api: CoreApi;
  docker: Docker;
  log: (line: string) => void;
  /** Injected so tests need not actually wait between retries. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How a unit's contract is loaded. The default reads the built `dist/contract.js`, which is what
   * `pnpm pipeline` produces before invoking this — injected so a test does not need a build.
   */
  loadContract?: (unit: Unit) => Promise<ContractEntry>;
}

const RETRYABLE_STATUS = new Set([502, 503]);
const MAX_ATTEMPTS = 20;

export async function deploy(o: DeployOptions): Promise<DeploymentRegistered> {
  const unit = findUnit(o.root, o.name);
  const contract = await (o.loadContract ?? contractFromDist)(unit);
  const schemas = contractSchemas(contract);

  const artifact = sourceDigest(o.root, unit.packageName);
  const digest = artifact.replace(/^sha256:/, '').slice(0, 12);
  const image = `ai-pipeline/${unit.metadata.name}:${unit.metadata.version}-${digest}`;
  const builtHere = !o.docker.imageExists(image);
  if (builtHere) {
    o.log(`▸ building ${image}`);
    o.docker.buildImage(o.root, unit.packageName, image);
  } else o.log(`▸ image ${image} is up to date`);

  const container = o.dev ? `${unit.metadata.name}-dev` : `${unit.metadata.name}-${digest}`;
  const { startedHere } = ensureContainer(o, unit, { container, image, artifact });

  const request: DeploymentRequest = {
    metadata: unit.metadata,
    schemas,
    contractHash: contractHash(schemas),
    artifactDigest: artifact,
    endpoint: `http://${container}:9080`,
    mode: o.dev ? 'dev' : 'immutable',
  };

  return register(o, request, { container, image, builtHere, startedHere });
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
  const env = { ...o.env, OTEL_SERVICE_NAME: unit.metadata.name };
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

async function register(
  o: DeployOptions,
  request: DeploymentRequest,
  target: { container: string; image: string; builtHere: boolean; startedHere: boolean },
): Promise<DeploymentRegistered> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await o.api<DeploymentRegistered>('POST', '/v1/deployments', request);
      o.log(`✔ ${result.name}@${result.version} → ${result.deploymentId} (${target.container})`);
      return result;
    } catch (error) {
      // Restate is still discovering the endpoint (502), or the catalogue sync after registration
      // needs another idempotent pass (503).
      const retryable = error instanceof ApiError && RETRYABLE_STATUS.has(error.status);
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(1000);
        continue;
      }
      if (target.startedHere && error instanceof ApiError && isPreRegistration(error.code)) {
        o.docker.removeContainer(target.container);
        if (target.builtHere) o.docker.removeImage(target.image);
      } else if (target.startedHere) {
        // Anything else may have registered the endpoint before failing — a 503 from the catalogue
        // sync certainly did, and a transport error cannot be distinguished from one. Removing the
        // container could break invocations Restate is already routing to it, so it stays, and the
        // operator is told rather than left to find it. Re-running the deploy adopts it.
        o.log(
          `▸ ${target.container} is still running and may be registered; re-run the deploy to retry, ` +
            `or \`docker rm -f ${target.container}\` once you have checked \`pipeline deployments\``,
        );
      }
      throw error;
    }
  }
}

/**
 * Whether core-api refused *before* registering the endpoint with Restate. Only then may this deploy
 * remove the container it started: afterwards Restate may already route invocations to it, and
 * removing the container would break them. The list is part of the wire contract.
 */
const isPreRegistration = (code: string): boolean =>
  PRE_REGISTRATION_CODES.includes(code as PipelineErrorCode);

/**
 * A unit's contract, loaded from its own `dist/contract.js`.
 *
 * Every unit ships one. There is deliberately no central registry: a shared map of name → contract
 * would be a file every unit's artifact digest depends on, so adding one workflow would change the
 * artifact of every other one and force a round of version bumps. Per-unit contracts are what make
 * units independently deployable.
 */
async function contractFromDist(unit: Unit): Promise<ContractEntry> {
  const file = join(unit.dir, 'dist/contract.js');
  if (!existsSync(file))
    throw new Error(
      `${unit.metadata.name} ships no contract at ${file}. Export \`contract\` from src/contract.ts, then build.`,
    );
  const { contract } = (await import(pathToFileURL(file).href)) as {
    contract?: ContractEntry;
  };
  if (!contract) throw new Error(`${file} does not export \`contract\``);
  if (contract.restateName !== unit.metadata.restateName)
    throw new Error(
      `contract restateName ${contract.restateName} ≠ metadata restateName ${unit.metadata.restateName}`,
    );
  // The runs API reads invocations by handler name, so a workflow's entry point must be `run`.
  if (unit.metadata.kind === 'workflow' && contract.handler !== 'run')
    throw new Error(
      `a workflow's contract handler must be "run" (${unit.metadata.name} declares "${contract.handler}"); ` +
        'the runs API selects invocations by that name.',
    );
  return contract;
}
