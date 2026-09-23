import { idempotencyKey, unitName } from '@ai-pipeline/api-contract/params';
import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import { triggerPatch, triggerPatched } from '@ai-pipeline/api-contract/triggers';
import {
  startRunAccepted,
  startRunRequest,
  workflowDetail,
  workflowList,
  workflowQuery,
} from '@ai-pipeline/api-contract/workflows';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeUnit, listUnits } from '../domain/catalogue.js';
import { startRun } from '../domain/runs.js';
import { setTriggerEnabled } from '../domain/triggers.js';

const nameParams = z.object({ name: unitName });
const triggerParams = z.object({ name: unitName, triggerId: unitName });

/** The catalogue, its triggers, and the REST entry point for starting a run. */
export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  const cp = app.controlPlane;

  app.get(
    '/workflows',
    { schema: { response: { 200: responseSchema(workflowList) } } },
    async (request) => {
      const { kind } = workflowQuery.parse(request.query);
      return { workflows: await listUnits(cp, kind) };
    },
  );

  app.get(
    '/workflows/:name',
    { schema: { response: { 200: responseSchema(workflowDetail) } } },
    async (request) => describeUnit(cp, nameParams.parse(request.params).name),
  );

  app.patch(
    '/workflows/:name/triggers/:triggerId',
    { schema: { response: { 200: responseSchema(triggerPatched) } } },
    async (request) => {
      const { name, triggerId } = triggerParams.parse(request.params);
      const { enabled } = triggerPatch.parse(request.body);
      const trigger = await setTriggerEnabled(cp, name, triggerId, enabled);
      return {
        ...trigger,
        // Switching a Kafka trigger off is eventually consistent, and saying so beats surprising
        // an operator with runs that start after they turned it off.
        ...(trigger.type === 'kafka' && !enabled
          ? {
              note: 'Records Restate already enqueued from this subscription may still start runs.',
            }
          : {}),
      };
    },
  );

  app.post(
    '/workflows/:name/runs',
    { schema: { response: { 202: responseSchema(startRunAccepted) } } },
    async (request, reply) => {
      const { name } = nameParams.parse(request.params);
      const { input } = startRunRequest.parse(request.body);
      const header = request.headers['idempotency-key'];
      const key = header === undefined ? undefined : idempotencyKey.parse(header);

      const accepted = await startRun(cp, name, input, key);
      return reply
        .code(202)
        .header('location', `/v1/runs/${name}/${accepted.runId}`)
        .send(accepted);
    },
  );
}
