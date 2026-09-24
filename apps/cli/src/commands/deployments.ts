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
 * deployment id, and pulling the container out from under that would break it. That question is
 * asked again after the retire, because the answer can change while the DELETE is in flight.
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
  const before = await listDeployments(api);
  const target = before.deployments.find((d) => d.deploymentId === deploymentId);
  const result = await api<DeploymentRetired>(
    'DELETE',
    `/v1/deployments/${encodeURIComponent(deploymentId)}`,
  );
  if (!target || target.status === 'retired') return result;

  // Whether the endpoint is still wanted is read *after* the retire, not from the snapshot above:
  // a deploy that registered this endpoint while the DELETE was in flight is invisible to the
  // earlier list, and removing its container would take down a runtime Restate already routes to.
  //
  // This narrows the window to the gap between this list and the `rm` below; it does not close it.
  // Closing it needs one owner for the whole check-and-delete, which is what the Kubernetes Restate
  // Operator would be — see docs/decisions.md. Until then, erring toward a leaked container beats
  // erring toward a deleted live one.
  const after = await listDeployments(api);
  const shared = after.deployments.some(
    (d) =>
      d.deploymentId !== deploymentId && d.status !== 'retired' && d.endpoint === target.endpoint,
  );
  if (shared) return result;

  const container = new URL(target.endpoint).hostname;
  const image = docker.containerImage(container);
  docker.removeContainer(container);
  if (image) docker.removeImage(image);
  return result;
}
