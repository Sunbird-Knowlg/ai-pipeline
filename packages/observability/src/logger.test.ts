import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, serializeError } from './logger.js';

/** Captures what the logger actually writes, so these assert the bytes, not the intent. */
function capture(): { lines: () => Record<string, unknown>[]; stream: Writable } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });
  return {
    stream,
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/**
 * The shape of an AI SDK `APICallError`: the prompt is on `requestBodyValues` and the gateway's
 * response headers are on `responseHeaders`. Both are enumerable own properties, which is why the
 * default pino error serializer emitted them.
 */
const modelError = () =>
  Object.assign(new Error('Unauthorized'), {
    name: 'AI_APICallError',
    url: 'http://litellm:4000/v1/chat/completions',
    statusCode: 401,
    requestBodyValues: {
      messages: [{ role: 'user', content: '<passage>a learner wrote this</passage>' }],
    },
    responseHeaders: { authorization: 'Bearer sk-master-key', 'content-type': 'application/json' },
  });

describe('serializeError', () => {
  it('keeps only the fields it declares', () => {
    expect(Object.keys(serializeError(modelError())).sort()).toEqual([
      'message',
      'stack',
      'status',
      'type',
    ]);
  });

  it('carries the identity of the failure', () => {
    const serialized = serializeError(modelError());
    expect(serialized).toMatchObject({
      type: 'AI_APICallError',
      message: 'Unauthorized',
      status: 401,
    });
  });

  it('keeps a `code`, and a cause without the cause’s own extra fields', () => {
    const cause = Object.assign(new Error('socket hang up'), { secret: 'do not log me' });
    const error = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET', cause });
    expect(serializeError(error)).toMatchObject({
      code: 'ECONNRESET',
      cause: { type: 'Error', message: 'socket hang up' },
    });
    expect(JSON.stringify(serializeError(error))).not.toContain('do not log me');
  });

  it('survives something that is not an Error at all', () => {
    expect(serializeError('boom')).toEqual({ type: 'string', message: 'boom' });
    expect(serializeError(undefined)).toEqual({ type: 'undefined', message: 'undefined' });
  });
});

describe('createLogger', () => {
  it('never writes the prompt or the gateway credential from a failed model call', () => {
    const sink = capture();
    const log = createLogger('svc', sink.stream);
    log.error({ error: modelError() }, 'model call failed');
    log.error({ err: modelError() }, 'model call failed');

    const written = JSON.stringify(sink.lines());
    expect(written).not.toContain('a learner wrote this');
    expect(written).not.toContain('sk-master-key');
    expect(written).not.toContain('requestBodyValues');
    expect(written).not.toContain('responseHeaders');
    // …while still saying what went wrong.
    expect(written).toContain('AI_APICallError');
    expect(written).toContain('Unauthorized');
  });

  it('still redacts the payload fields it always did', () => {
    const sink = capture();
    createLogger('svc', sink.stream).info(
      { input: { secret: 1 }, text: 'a whole document', apiKey: 'sk-1' },
      'handled',
    );
    const written = JSON.stringify(sink.lines());
    expect(written).not.toContain('a whole document');
    expect(written).not.toContain('sk-1');
  });

  it('tags every line with the service', () => {
    const sink = capture();
    createLogger('content-authoring', sink.stream).info('up');
    expect(sink.lines()[0]).toMatchObject({ service: 'content-authoring', msg: 'up' });
  });
});
