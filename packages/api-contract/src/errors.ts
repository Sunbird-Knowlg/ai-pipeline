import { z } from 'zod';

/**
 * Every code the core API can put on the wire.
 *
 * This is a contract, not an implementation detail: the deploy CLI decides whether to tear a
 * container down by inspecting the code, so a rename must break the build on both sides rather than
 * silently change deploy behaviour.
 *
 * Grouped by what a caller should do about it.
 */
export const ERROR_CODES = [
  // Malformed request: fix the call.
  'INVALID_REQUEST',
  'INVALID_INPUT',
  'INVALID_CURSOR',
  'INVALID_METADATA',
  'INVALID_SCHEMA',
  'INVALID_CONFIG',
  // Refused by the host guard (there is no auth in v1).
  'INVALID_HOST',
  'CROSS_SITE_REQUEST',
  // Nothing there.
  'NOT_FOUND',
  'ROUTE_NOT_FOUND',
  // The catalogue says this cannot be done yet.
  'NOT_INVOCABLE',
  'NOT_DEPLOYED',
  'NO_REST_TRIGGER',
  'TRIGGER_DISABLED',
  'RUN_COMPLETED',
  // Registration conflicts: bump the version, or deploy the dependency first.
  'RESTATE_NAME_TAKEN',
  'VERSION_CONTRACT_CONFLICT',
  'VERSION_ARTIFACT_CONFLICT',
  'DEPENDENCY_NOT_REGISTERED',
  'DEPENDENCY_NOT_DEPLOYED',
  'SERVICE_MISMATCH',
  'ROUTING_UNKNOWN',
  // Retirement refusals.
  'DEPLOYMENT_ACTIVE',
  'DEPLOYMENT_NOT_DRAINED',
  // Retryable: the call may succeed on a later attempt.
  'CATALOGUE_SYNC_FAILED',
  'RESTATE_UNAVAILABLE',
  'RESTATE_ADMIN_ERROR',
  'RESTATE_INGRESS_ERROR',
  // Unexpected.
  'INTERNAL',
] as const;

export type PipelineErrorCode = (typeof ERROR_CODES)[number];

/** The error envelope every non-2xx response uses. */
export const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

/**
 * Refusals raised before the control plane registers an endpoint with Restate. Only after one of
 * these is it safe for the deploy CLI to remove the container it just started: once registration
 * has happened, Restate may already be routing invocations to that endpoint.
 */
export const PRE_REGISTRATION_CODES: readonly PipelineErrorCode[] = [
  'INVALID_REQUEST',
  'INVALID_METADATA',
  'INVALID_SCHEMA',
  'INVALID_CONFIG',
  'RESTATE_NAME_TAKEN',
  'VERSION_CONTRACT_CONFLICT',
  'VERSION_ARTIFACT_CONFLICT',
  'DEPENDENCY_NOT_REGISTERED',
  'DEPENDENCY_NOT_DEPLOYED',
  'SERVICE_MISMATCH',
];
