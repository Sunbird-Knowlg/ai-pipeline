import type { Metadata } from '@ai-pipeline/metadata/metadata';
import { trace } from '@opentelemetry/api';
import type { ServiceOptions, WorkflowOptions } from '@restatedev/restate-sdk';
import { openTelemetryHook } from '@restatedev/restate-sdk-opentelemetry';

const RETENTION = { days: 7 };

/**
 * Shared Restate service options. Invocation-level retries pause (not kill) when exhausted, so
 * an invocation hit by a bug keeps its state and can be resumed after a fix.
 */
export function serviceOptions(metadata: Metadata): ServiceOptions {
  return {
    journalRetention: RETENTION,
    idempotencyRetention: RETENTION,
    inactivityTimeout: { minutes: 5 },
    abortTimeout: { minutes: 15 },
    retryPolicy: {
      maxAttempts: 10,
      onMaxAttempts: 'pause',
      initialInterval: { seconds: 1 },
      maxInterval: { seconds: 60 },
    },
    ingressPrivate: metadata.visibility === 'private',
    hooks: [openTelemetryHook({ tracer: trace.getTracer(metadata.name) })],
  };
}

export function workflowOptions(metadata: Metadata): WorkflowOptions {
  return { ...serviceOptions(metadata), workflowRetention: RETENTION };
}
