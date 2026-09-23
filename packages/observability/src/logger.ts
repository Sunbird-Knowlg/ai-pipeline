import { context, trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string): Logger {
  return pino({
    base: { service },
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'headers.authorization', 'apiKey', 'input', 'text'],
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    mixin() {
      const span = trace.getSpan(context.active())?.spanContext();
      return span ? { traceId: span.traceId, spanId: span.spanId } : {};
    },
  });
}
