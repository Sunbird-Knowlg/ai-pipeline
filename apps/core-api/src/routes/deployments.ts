import {
  deploymentList,
  deploymentQuery,
  deploymentRegistered,
  deploymentRequest,
  deploymentRetired,
} from '@ai-pipeline/api-contract/deployments';
import { deploymentId as deploymentIdSchema } from '@ai-pipeline/api-contract/params';
import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerDeployment } from '../domain/registration.js';
import { inFlight, retireDeployment } from '../domain/retirement.js';
import { toDeploymentView } from '../views.js';

/** The control plane. Only `pnpm pipeline` talks to these routes. */
export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  const cp = app.controlPlane;

  app.post(
    '/deployments',
    { schema: { response: { 201: responseSchema(deploymentRegistered) } } },
    async (request, reply) => {
      const result = await registerDeployment(cp, deploymentRequest.parse(request.body));
      return reply.code(201).send(result);
    },
  );

  app.get(
    '/deployments',
    { schema: { response: { 200: responseSchema(deploymentList) } } },
    async (request) => {
      const { name } = deploymentQuery.parse(request.query);
      const deployments = await cp.store.deployments.list(name);
      return {
        deployments: await Promise.all(
          deployments.map(async (deployment) =>
            toDeploymentView(
              deployment,
              // A retired deployment has nothing pinned to it by definition; don't ask Restate.
              deployment.status === 'retired'
                ? 0
                : await inFlight(cp.admin, deployment.deploymentId),
            ),
          ),
        ),
      };
    },
  );

  app.delete(
    '/deployments/:id',
    { schema: { response: { 200: responseSchema(deploymentRetired) } } },
    async (request) => {
      const { id } = z.object({ id: deploymentIdSchema }).parse(request.params);
      return retireDeployment(cp, id);
    },
  );
}
