import { liveness, readiness } from '@ai-pipeline/api-contract/health';
import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import type { FastifyInstance } from 'fastify';

/** Liveness is "the process answers"; readiness is "both stores answer". */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { store, admin } = app.controlPlane;

  app.get(
    '/health/live',
    { schema: { response: { 200: responseSchema(liveness) } } },
    async () => ({
      status: 'ok' as const,
    }),
  );

  app.get(
    '/health/ready',
    { schema: { response: { 200: responseSchema(readiness), 503: responseSchema(readiness) } } },
    async (_request, reply) => {
      const [postgres, restate] = await Promise.all([store.reachable(), admin.health()]);
      const ready = postgres && restate;
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? 'ready' : 'not_ready', dependencies: { postgres, restate } });
    },
  );
}
