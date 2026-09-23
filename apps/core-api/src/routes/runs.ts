import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import {
  runCancelling,
  runList,
  runParams,
  runQuery,
  runView,
} from '@ai-pipeline/api-contract/runs';
import type { FastifyInstance } from 'fastify';
import { cancelRun, getRun, listRuns } from '../domain/runs.js';

/** Runs. Restate is the store; these routes read it and ask it to cancel. */
export async function runRoutes(app: FastifyInstance): Promise<void> {
  const cp = app.controlPlane;

  app.get('/runs', { schema: { response: { 200: responseSchema(runList) } } }, async (request) =>
    listRuns(cp, runQuery.parse(request.query)),
  );

  app.get(
    '/runs/:workflow/:runId',
    { schema: { response: { 200: responseSchema(runView) } } },
    async (request) => {
      const { workflow, runId } = runParams.parse(request.params);
      return getRun(cp, workflow, runId);
    },
  );

  app.post(
    '/runs/:workflow/:runId/cancel',
    { schema: { response: { 202: responseSchema(runCancelling) } } },
    async (request, reply) => {
      const { workflow, runId } = runParams.parse(request.params);
      return reply.code(202).send(await cancelRun(cp, workflow, runId));
    },
  );
}
