import { Writable } from 'node:stream';
import { createLogger } from '@ai-pipeline/observability/logger';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PipelineError } from '../errors.js';
import { errorsPlugin } from './errors.js';

/** An app whose routes throw `error`, and the log lines it writes. */
function failing(error: Error) {
  const lines: { level: number; msg: string; err?: Record<string, any> }[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  const app = Fastify({ loggerInstance: createLogger('test', sink) });
  void app.register(errorsPlugin);
  app.get('/', async () => {
    throw error;
  });
  return { app, lines, logged: (level: number) => lines.filter((l) => l.level === level) };
}

const WARN = 40;
const ERROR = 50;

describe('failures', () => {
  // A 5xx PipelineError is a dependency failing. Its cause — Restate's own message, the socket
  // error — reaches no one but the log, so it has to reach the log.
  it('logs a 5xx PipelineError at warn, with its cause', async () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.7:8080');
    const { app, logged } = failing(
      new PipelineError('RESTATE_UNAVAILABLE', 'Restate ingress is unavailable', 503, { cause }),
    );
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: 'RESTATE_UNAVAILABLE', message: 'Restate ingress is unavailable' },
    });
    expect(logged(WARN)).toEqual([
      expect.objectContaining({
        msg: 'request failed',
        err: expect.objectContaining({
          type: 'PipelineError',
          message: 'Restate ingress is unavailable',
          status: 503,
          cause: { type: 'Error', message: 'connect ECONNREFUSED 10.0.0.7:8080' },
        }),
      }),
    ]);
  });

  it('does not log a refusal of the caller’s request', async () => {
    const { app, lines } = failing(
      new PipelineError('NOT_FOUND', 'collection docs not found', 404),
    );
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect(lines.filter((l) => l.level >= WARN)).toEqual([]);
  });

  it('still logs an unexpected error at error, and answers a bare INTERNAL', async () => {
    const { app, logged } = failing(new RangeError('Maximum call stack size exceeded'));
    const res = await app.inject({ url: '/' });
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal error' } });
    expect(logged(ERROR)).toEqual([
      expect.objectContaining({ err: expect.objectContaining({ type: 'RangeError' }) }),
    ]);
  });
});
