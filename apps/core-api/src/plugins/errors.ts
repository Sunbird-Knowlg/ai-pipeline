import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { PipelineError } from '../errors.js';

/**
 * Everything that leaves this API as a failure leaves as `{ error: { code, message } }`.
 *
 * Four sources are mapped: our own `PipelineError`, a zod parse failure on params/query/body,
 * Fastify's own 4xx (a malformed JSON body, a payload over the limit), and anything else — which is
 * logged in full and reported as a bare `INTERNAL`, since an unexpected message may carry internals.
 *
 * A `PipelineError` of 500 or more is logged too, at warn: it is a dependency failing (Restate,
 * a unit), never the caller's mistake, and its cause — Restate's own message, the socket error —
 * reaches no one else.
 */
export const errorsPlugin = fp(
  async (app) => {
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof PipelineError) {
        if (error.statusCode >= 500) request.log.warn({ err: error }, 'request failed');
        return reply
          .code(error.statusCode)
          .send({ error: { code: error.code, message: error.message } });
      }

      if (error instanceof ZodError)
        return reply.code(400).send({
          error: {
            code: 'INVALID_REQUEST',
            message: error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; '),
          },
        });

      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500)
        return reply
          .code(status)
          .send({ error: { code: 'INVALID_REQUEST', message: (error as Error).message } });

      request.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
    });

    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } }),
    );
  },
  { name: 'errors' },
);

/**
 * The envelope for what Fastify refuses before routing: a URL its router cannot read — a bad
 * percent-encoding (`FST_ERR_BAD_URL`, 400), a path parameter over `maxParamLength`
 * (`FST_ERR_MAX_PARAM_LENGTH`, 414). Those never reach a hook or the error handler above, and
 * Fastify would otherwise answer them in a body of its own. Pass it as `Fastify({ frameworkErrors })`.
 */
export function frameworkErrors(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const status = error.statusCode ?? 400;
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed');
    void reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error' } });
    return;
  }
  void reply.code(status).send({ error: { code: 'INVALID_REQUEST', message: error.message } });
}
