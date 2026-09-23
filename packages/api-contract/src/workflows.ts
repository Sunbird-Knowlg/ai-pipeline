import { z } from 'zod';
import {
  deploymentId,
  deploymentMode,
  deploymentStatus,
  opaqueJson,
  timestamp,
  unitKind,
  unitName,
  visibility,
} from './params.js';
import { triggerView } from './triggers.js';

/** The catalogue surface. "Workflow" here covers both kinds of catalogued unit, as the paths do. */

const dependency = z.object({ name: unitName, kind: unitKind });

export const workflowSummary = z.object({
  name: unitName,
  kind: unitKind,
  version: z.string(),
  restateName: z.string(),
  visibility,
  description: z.string(),
  /** The deployment Restate routes new invocations to; absent until one is registered. */
  activeDeployment: deploymentId.optional(),
  triggers: z.array(triggerView),
  dependencies: z.array(dependency),
});
export type WorkflowSummary = z.infer<typeof workflowSummary>;

export const workflowList = z.object({ workflows: z.array(workflowSummary) });
export type WorkflowList = z.infer<typeof workflowList>;

export const workflowDetail = z.object({
  name: unitName,
  kind: unitKind,
  version: z.string(),
  restateName: z.string(),
  visibility,
  description: z.string(),
  /** The unit's declared config, as validated against its contract's config schema. */
  config: z.record(z.string(), opaqueJson),
  /** Draft-07 JSON Schemas generated from the unit's contract at deploy time. */
  schemas: z.object({
    input: z.record(z.string(), opaqueJson),
    output: z.record(z.string(), opaqueJson),
    config: z.record(z.string(), opaqueJson),
  }),
  contractHash: z.string(),
  triggers: z.array(triggerView),
  dependencies: z.array(dependency),
  versions: z.array(
    z.object({ version: z.string(), contractHash: z.string(), registeredAt: timestamp }),
  ),
  deployments: z.array(
    z.object({
      deploymentId,
      version: z.string(),
      status: deploymentStatus,
      mode: deploymentMode,
      endpoint: z.string(),
      artifactDigest: z.string(),
      registeredAt: timestamp,
    }),
  ),
});
export type WorkflowDetail = z.infer<typeof workflowDetail>;

export const workflowQuery = z.strictObject({ kind: unitKind.optional() });

/**
 * Starting a run. The body carries only the canonical input; the trigger context is added by the
 * control plane so a caller can never forge where a run came from.
 */
export const startRunRequest = z.strictObject({ input: opaqueJson });
export type StartRunRequest = z.infer<typeof startRunRequest>;

export const startRunAccepted = z.object({
  runId: z.string(),
  invocationId: z.string(),
  /** `PreviouslyAccepted` means an Idempotency-Key matched a run that already exists. */
  status: z.enum(['Accepted', 'PreviouslyAccepted']),
});
export type StartRunAccepted = z.infer<typeof startRunAccepted>;
