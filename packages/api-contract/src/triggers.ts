import { z } from 'zod';

/**
 * A trigger as the API reports it: the desired state the catalogue holds, next to the state
 * observed in Restate.
 *
 * They differ on purpose, and the difference is the point. Deleting a Kafka subscription stops its
 * consumer, but records Restate already enqueued still start runs — so a trigger switched off reads
 * `disabling` until its subscription is gone, and `disabled` never means "nothing in flight".
 */
export const observedStatus = z.enum(['active', 'disabling', 'disabled', 'pending', 'error']);
export type ObservedStatus = z.infer<typeof observedStatus>;

export const triggerType = z.enum(['rest', 'kafka']);
export type TriggerType = z.infer<typeof triggerType>;

export const triggerView = z.object({
  id: z.string(),
  type: triggerType,
  /** `kafka://<cluster>/<topic>` for a Kafka trigger; absent for REST. */
  source: z.string().optional(),
  desiredEnabled: z.boolean(),
  observedStatus,
  subscriptionId: z.string().optional(),
  lastError: z.string().optional(),
});
export type TriggerView = z.infer<typeof triggerView>;

export const triggerPatch = z.strictObject({ enabled: z.boolean() });
export type TriggerPatch = z.infer<typeof triggerPatch>;

/** The PATCH response repeats the view and, when switching a Kafka trigger off, says why it lingers. */
export const triggerPatched = triggerView.extend({ note: z.string().optional() });
export type TriggerPatched = z.infer<typeof triggerPatched>;
