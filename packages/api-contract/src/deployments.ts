import { z } from 'zod';
import {
  deploymentId,
  deploymentMode,
  deploymentStatus,
  opaqueJson,
  timestamp,
  unitName,
} from './params.js';
import { triggerView } from './triggers.js';

/**
 * The control-plane surface: `pnpm pipeline deploy` builds an artifact, starts its container and
 * posts this; `retire` deletes it once drained.
 */

export const deploymentRequest = z.strictObject({
  /** Validated by `@ai-pipeline/metadata`, which the control plane owns — not by this package. */
  metadata: opaqueJson,
  schemas: z.strictObject({
    input: z.record(z.string(), opaqueJson),
    output: z.record(z.string(), opaqueJson),
    config: z.record(z.string(), opaqueJson),
  }),
  contractHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  artifactDigest: z.string().min(1).max(200),
  endpoint: z.url(),
  mode: deploymentMode.default('immutable'),
});
export type DeploymentRequest = z.infer<typeof deploymentRequest>;

export const deploymentRegistered = z.object({
  name: unitName,
  version: z.string(),
  deploymentId,
  /** Whether Restate now routes new invocations here. False when an older build was re-registered. */
  active: z.boolean(),
  note: z.string().optional(),
  triggers: z.array(triggerView),
});
export type DeploymentRegistered = z.infer<typeof deploymentRegistered>;

export const deploymentView = z.object({
  deploymentId,
  name: unitName,
  version: z.string(),
  endpoint: z.string(),
  artifactDigest: z.string(),
  mode: deploymentMode,
  status: deploymentStatus,
  registeredAt: timestamp,
  drainedAt: timestamp.optional(),
  /** Invocations still pinned here; they must finish on this deployment before it can retire. */
  inFlight: z.number().int().nonnegative(),
});
export type DeploymentView = z.infer<typeof deploymentView>;

export const deploymentList = z.object({ deployments: z.array(deploymentView) });
export type DeploymentList = z.infer<typeof deploymentList>;

export const deploymentRetired = z.object({
  deploymentId,
  status: z.literal('retired'),
});
export type DeploymentRetired = z.infer<typeof deploymentRetired>;

export const deploymentQuery = z.object({ name: unitName.optional() });
