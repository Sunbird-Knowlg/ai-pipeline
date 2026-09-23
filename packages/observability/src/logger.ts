import { context, trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * What may be logged from an error, and nothing else.
 *
 * `pino.stdSerializers.err` re-emits every enumerable own property of the error, which is the wrong
 * default here: an AI SDK `APICallError` carries `requestBodyValues` — the entire prompt, so the
 * content this pipeline processes — and `responseHeaders`, which can carry the gateway's
 * `authorization`. Neither is matched by a `redact` path, because the shape is the library's, not
 * ours, and it changes between versions. So this allows fields in rather than trying to redact them
 * out: a field a library adds tomorrow is dropped, not leaked.
 */
interface LoggableError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  status?: number;
  cause?: { type: string; message: string };
}

export function serializeError(value: unknown): LoggableError {
  if (!(value instanceof Error)) return { type: typeof value, message: String(value) };
  const error = value as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof error.status === 'number' ? error.status : error.statusCode;
  // `code` is only taken when it is already a scalar: an object here would stringify to
  // `[object Object]`, and whatever it held would be lost rather than logged.
  const code =
    typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
  return {
    type: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(code === undefined ? {} : { code: String(code) }),
    ...(typeof status === 'number' ? { status } : {}),
    ...(error.cause instanceof Error
      ? { cause: { type: error.cause.name, message: error.cause.message } }
      : {}),
  };
}

/** `destination` is injectable so a test can read back exactly what was written. */
export function createLogger(service: string, destination?: DestinationStream): Logger {
  return pino(
    {
      base: { service },
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'headers.authorization', 'apiKey', 'input', 'text'],
      serializers: { err: serializeError, error: serializeError },
      mixin() {
        const span = trace.getSpan(context.active())?.spanContext();
        return span ? { traceId: span.traceId, spanId: span.spanId } : {};
      },
    },
    destination,
  );
}
