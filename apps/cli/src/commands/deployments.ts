import type { DeploymentList, DeploymentRetired } from '@ai-pipeline/api-contract/deployments';
import type { CoreApi } from '../core-api.js';
import type { Docker } from '../docker.js';

export async function listDeployments(api: CoreApi, name?: string): Promise<DeploymentList> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  return api<DeploymentList>('GET', `/v1/deployments${query}`);
}

/**
 * Retires a drained deployment, then stops the container that served it.
 *
 * The container is stopped only when *this* call is what retired it, and only when no other live
 * deployment shares its endpoint — the same artifact can be registered again later under a new
 * deployment id, and pulling the container out from under that would break it.
 */
export async function retireDeployment(
  api: CoreApi,
  docker: Docker,
  deploymentId: string,
): Promise<DeploymentRetired> {
  const { deployments } = await listDeployments(api);
  const target = deployments.find((d) => d.deploymentId === deploymentId);
  const result = await api<DeploymentRetired>(
    'DELETE',
    `/v1/deployments/${encodeURIComponent(deploymentId)}`,
  );

  const shared = deployments.some(
    (d) =>
      d.deploymentId !== deploymentId && d.status !== 'retired' && d.endpoint === target?.endpoint,
  );
  if (target && target.status !== 'retired' && !shared)
    docker.removeContainer(new URL(target.endpoint).hostname);
  return result;
}
