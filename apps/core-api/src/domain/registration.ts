import type {
  DeploymentRegistered,
  DeploymentRequest,
} from '@ai-pipeline/api-contract/deployments';
import { parseMetadata, type Metadata } from '@ai-pipeline/metadata/metadata';
import { triggerServiceName } from '@ai-pipeline/metadata/naming';
import { assert, PipelineError } from '../errors.js';
import { compileOrThrow, validateOnce } from '../json-schema.js';
import type { Catalogue } from '../store/store.js';
import type { ControlPlane } from './deps.js';
import { registrationConflict } from './reconcile.js';
import { reconcileLock, reconcileWithin } from './triggers.js';

/**
 * Registering one build.
 *
 * The order matters and is the whole reason this is a module rather than a route handler:
 *
 *  1. everything that can refuse cheaply refuses first, while nothing has changed;
 *  2. the endpoint is discovered with `dry_run` to check what it actually serves — before Restate
 *     can route anything to it;
 *  3. Restate registration happens next, so a failure there leaves the catalogue untouched;
 *  4. every step after that is idempotent, so a failure is reported as retryable (503) rather than
 *     torn down — by then Restate may already be routing invocations to the new endpoint.
 *
 * The deploy CLI depends on that split: it removes the container it started only for the refusals
 * in step 1 and 2 (`PRE_REGISTRATION_CODES` in the API contract).
 */
export async function registerDeployment(
  cp: ControlPlane,
  request: DeploymentRequest,
): Promise<DeploymentRegistered> {
  let metadata: Metadata;
  try {
    metadata = parseMetadata(request.metadata);
  } catch (error) {
    throw new PipelineError('INVALID_METADATA', (error as Error).message.slice(0, 1000), 400);
  }
  // Both locks up front, on one connection. This section ends in a trigger reconcile, and taking
  // that lock from a nested `withLock` would check out a second connection while this one is still
  // held — which starves the pool rather than serialising anything.
  return cp.store.withLock(
    [`register:${metadata.name}`, reconcileLock(metadata.name)],
    (catalogue) => register(cp, catalogue, request, metadata),
  );
}

async function register(
  cp: ControlPlane,
  catalogue: Catalogue,
  request: DeploymentRequest,
  metadata: Metadata,
): Promise<DeploymentRegistered> {
  await checkSchemas(request);
  await checkNameIsFree(catalogue, metadata);
  await checkVersionRule(catalogue, request, metadata);
  await checkDependencies(cp, catalogue, metadata);
  await checkEndpointServes(cp, request, metadata);

  const deployment = await cp.admin.registerDeployment(request.endpoint, request.mode === 'dev');
  try {
    return await syncCatalogue(cp, catalogue, request, metadata, deployment.id);
  } catch (error) {
    if (error instanceof PipelineError && error.statusCode < 500) throw error;
    throw new PipelineError(
      'CATALOGUE_SYNC_FAILED',
      `registered ${deployment.id} in Restate but syncing the catalogue failed; retry the deploy: ${(error as Error).message}`.slice(
        0,
        800,
      ),
      503,
      { cause: error },
    );
  }
}

/** The schemas must compile with the same Ajv the API validates input with. */
async function checkSchemas(request: DeploymentRequest): Promise<void> {
  for (const [which, schema] of Object.entries(request.schemas)) {
    try {
      compileOrThrow(schema);
    } catch (error) {
      throw new PipelineError(
        'INVALID_SCHEMA',
        `${which} schema does not compile: ${(error as Error).message}`,
        400,
      );
    }
  }
}

async function checkNameIsFree(catalogue: Catalogue, metadata: Metadata): Promise<void> {
  const others = await catalogue.definitions.namesUsingRestateName(
    metadata.restateName,
    metadata.name,
  );
  assert(
    others.length === 0,
    'RESTATE_NAME_TAKEN',
    `Restate name ${metadata.restateName} is used by ${others.join(', ')}`,
    409,
  );
}

/** A semantic version names one contract and, in immutable mode, one artifact. */
async function checkVersionRule(
  catalogue: Catalogue,
  request: DeploymentRequest,
  metadata: Metadata,
): Promise<void> {
  const configErrors = validateOnce(request.schemas.config, metadata.config);
  if (configErrors)
    throw new PipelineError('INVALID_CONFIG', `metadata.json config: ${configErrors}`, 400);

  const existing = await catalogue.definitions.find(metadata.name, metadata.version);
  const artifacts = await catalogue.deployments.artifactsOfVersion(metadata.name, metadata.version);
  const conflict = registrationConflict(
    request.mode,
    existing && { contractHash: existing.contractHash },
    artifacts,
    request,
  );
  if (conflict) throw new PipelineError(conflict.code, conflict.message, 409);
}

async function checkDependencies(
  cp: ControlPlane,
  catalogue: Catalogue,
  metadata: Metadata,
): Promise<void> {
  for (const dependency of metadata.dependencies) {
    const target = await catalogue.definitions.current(dependency.name);
    assert(
      target,
      'DEPENDENCY_NOT_REGISTERED',
      `dependency ${dependency.name} is not in the catalogue; deploy it first`,
      409,
    );
    assert(
      await cp.admin.serviceExists(target.restateName),
      'DEPENDENCY_NOT_DEPLOYED',
      `dependency ${dependency.name} (${target.restateName}) is not deployed in Restate`,
      409,
    );
  }
}

/** Validates what the endpoint serves *before* Restate starts routing to it. */
async function checkEndpointServes(
  cp: ControlPlane,
  request: DeploymentRequest,
  metadata: Metadata,
): Promise<void> {
  const probe = await cp.admin.dryRunDeployment(request.endpoint, request.mode === 'dev');
  const served = probe.services.map((s) => s.name);
  const owned = new Set([metadata.restateName, triggerServiceName(metadata.restateName)]);
  assert(
    served.includes(metadata.restateName) && served.every((s) => owned.has(s)),
    'SERVICE_MISMATCH',
    `endpoint must serve ${metadata.restateName} (and optionally its trigger service) only; it serves: ${served.join(', ')}`,
    422,
  );
}

async function syncCatalogue(
  cp: ControlPlane,
  catalogue: Catalogue,
  request: DeploymentRequest,
  metadata: Metadata,
  deploymentId: string,
): Promise<DeploymentRegistered> {
  // Re-registering an older, unchanged endpoint does not move routing back to it.
  const routedTo = (await cp.admin.service(metadata.restateName))?.deployment_id ?? deploymentId;
  const active = routedTo === deploymentId;

  await catalogue.transaction(async (tx) => {
    await tx.definitions.upsert({
      name: metadata.name,
      version: metadata.version,
      kind: metadata.kind,
      restateName: metadata.restateName,
      visibility: metadata.visibility,
      description: metadata.description,
      metadata,
      schemas: request.schemas,
      contractHash: request.contractHash,
    });
    await tx.dependencies.replace(metadata.name, metadata.version, metadata.dependencies);
    await tx.deployments.upsert({
      deploymentId,
      name: metadata.name,
      version: metadata.version,
      endpoint: request.endpoint,
      artifactDigest: request.artifactDigest,
      mode: request.mode,
    });
    const known = await tx.deployments.setActive(metadata.name, routedTo);
    assert(
      known,
      'ROUTING_UNKNOWN',
      `Restate routes ${metadata.restateName} to ${routedTo}, which the catalogue does not know; redeploy the current build`,
      409,
    );
    // Triggers follow the routed (current) build, never an older one registered again.
    if (active) await tx.triggers.sync(metadata.name, metadata.triggers);
  });

  // The caller already holds the reconcile lock, so this runs on the same connection.
  const triggers = await reconcileWithin(cp, catalogue, metadata.name);
  cp.log.info(
    { name: metadata.name, version: metadata.version, deploymentId, routedTo },
    'deployment registered',
  );
  return {
    name: metadata.name,
    version: metadata.version,
    deploymentId,
    active,
    ...(active
      ? {}
      : {
          note: `Restate still routes new invocations to ${routedTo}; this endpoint was already registered as an older deployment. Deploy a new build to roll forward.`,
        }),
    triggers,
  };
}
