import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import {
  runCancelling,
  runKilling,
  runList,
  runParams,
  runQuery,
  runResumeBody,
  runResuming,
  runView,
} from '@ai-pipeline/api-contract/runs';
import type { FastifyInstance } from 'fastify';
import { cancelRun, getRun, killRun, listRuns, resumeRun } from '../domain/runs.js';

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

  // Cancel asks a handler to finish; kill does not wait. Both are needed by an operator.
  app.post(
    '/runs/:workflow/:runId/kill',
    { schema: { response: { 202: responseSchema(runKilling) } } },
    async (request, reply) => {
      const { workflow, runId } = runParams.parse(request.params);
      return reply.code(202).send(await killRun(cp, workflow, runId));
    },
  );

  // The counterpart to the retry policy pausing an invocation rather than failing it. The body may
  // name one of the paused calls `GET /runs/:workflow/:runId` reports in `blocked`; without it, the
  // run's own invocation is resumed.
  app.post(
    '/runs/:workflow/:runId/resume',
    { schema: { response: { 202: responseSchema(runResuming) } } },
    async (request, reply) => {
      const { workflow, runId } = runParams.parse(request.params);
      const { invocationId } = runResumeBody.parse(request.body ?? {});
      return reply.code(202).send(await resumeRun(cp, workflow, runId, invocationId));
    },
  );
}
