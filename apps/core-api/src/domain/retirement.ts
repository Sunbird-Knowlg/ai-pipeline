import type { DeploymentRetired } from '@ai-pipeline/api-contract/deployments';
import { assert, notFound } from '../errors.js';
import type { RestateAdminPort } from '../restate/admin.js';
import { inFlightByDeploymentSql, inFlightSql } from '../restate/invocations.js';
import type { Catalogue } from '../store/store.js';
import type { ControlPlane } from './deps.js';

/** Invocations still pinned to a deployment. They must finish there before it can be removed. */
export async function inFlight(
  admin: Pick<RestateAdminPort, 'query'>,
  deploymentId: string,
): Promise<number> {
  const [row] = await admin.query<{ n: number }>(inFlightSql(deploymentId));
  return Number(row?.n ?? 0);
}

/**
 * In-flight counts for a whole set of deployments, in one query. Absent ids have nothing pinned.
 */
export async function inFlightByDeployment(
  admin: Pick<RestateAdminPort, 'query'>,
  deploymentIds: string[],
): Promise<Map<string, number>> {
  if (deploymentIds.length === 0) return new Map();
  const rows = await admin.query<{ id: string; n: number }>(inFlightByDeploymentSql(deploymentIds));
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

/**
 * Retiring a deployment.
 *
 * Three refusals, in order of how badly getting them wrong would hurt: the catalogue's own
 * `active` flag, then Restate's actual routing (which wins over the catalogue if they disagree),
 * then the in-flight count. Removing a deployment Restate still routes to would break new
 * invocations; removing one with in-flight work would break runs mid-journal.
 */
export async function retireDeployment(
  cp: ControlPlane,
  deploymentId: string,
): Promise<DeploymentRetired> {
  // Which unit this deployment belongs to is fixed; reading it outside the lock is safe, and it is
  // what tells us which lock to take.
  const target = await cp.store.deployments.find(deploymentId);
  if (!target) throw notFound(`deployment ${deploymentId}`);
  // Under the same lock a registration takes: retiring is check-then-act across Restate *and* the
  // catalogue, and a concurrent deploy of the same unit moves the routing this reads.
  return cp.store.withLock([`register:${target.name}`], (catalogue) =>
    retire(cp, catalogue, deploymentId),
  );
}

async function retire(
  cp: ControlPlane,
  catalogue: Catalogue,
  deploymentId: string,
): Promise<DeploymentRetired> {
  const deployment = await catalogue.deployments.find(deploymentId);
  if (!deployment) throw notFound(`deployment ${deploymentId}`);
  if (deployment.status === 'retired') return { deploymentId, status: 'retired' };

  assert(
    deployment.status !== 'active',
    'DEPLOYMENT_ACTIVE',
    'the active deployment cannot be retired; deploy a newer build first',
    409,
  );

  const definition = await catalogue.definitions.find(deployment.name, deployment.version);
  const routedTo = definition && (await cp.admin.service(definition.restateName))?.deployment_id;
  assert(
    routedTo !== deploymentId,
    'DEPLOYMENT_ACTIVE',
    `Restate still routes ${definition?.restateName} to ${deploymentId}; deploy a newer build first`,
    409,
  );

  const pending = await inFlight(cp.admin, deploymentId);
  assert(
    pending === 0,
    'DEPLOYMENT_NOT_DRAINED',
    `${pending} invocation(s) are still pinned to ${deploymentId}`,
    409,
  );

  await cp.admin.deleteDeployment(deploymentId);
  await catalogue.deployments.retire(deploymentId);
  return { deploymentId, status: 'retired' };
}
