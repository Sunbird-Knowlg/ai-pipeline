import type { DeploymentList, DeploymentRetired } from '@ai-pipeline/api-contract/deployments';
import type { CoreApi } from '../core-api.js';
import type { Docker } from '../docker.js';

export async function listDeployments(api: CoreApi, name?: string): Promise<DeploymentList> {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  return api<DeploymentList>('GET', `/v1/deployments${query}`);
}

/**
 * Retires a drained deployment, then stops the container that served it and reclaims its image.
 *
 * The container is stopped only when *this* call is what retired it, and only when no other live
 * deployment shares its endpoint — the same artifact can be registered again later under a new
 * deployment id, and pulling the container out from under that would break it.
 *
 * The image goes with it. Every immutable deploy builds one, tagged with the artifact digest, and
 * nothing else ever removes them: a few weeks of development leaves tens of gigabytes of images for
 * deployments that were retired long ago. `removeImage` is already a no-op when another container
 * still uses the tag, which is the case that has to stay safe.
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
  if (target && target.status !== 'retired' && !shared) {
    const container = new URL(target.endpoint).hostname;
    const image = docker.containerImage(container);
    docker.removeContainer(container);
    if (image) docker.removeImage(image);
  }
  return result;
}
