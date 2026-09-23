import { type Metadata } from '@ai-pipeline/metadata/metadata';
import type { PipelineErrorCode } from '@ai-pipeline/api-contract/errors';
import { kafkaHandlerName, triggerServiceName } from '@ai-pipeline/metadata/naming';
import type { Subscription } from '../restate/admin.js';

export interface DesiredSubscription {
  triggerId: string;
  source: string;
  sink: string;
  options: Record<string, string>;
}

/** Sink prefix owned by one workflow: every subscription into its trigger service. */
export const sinkPrefix = (restateName: string) => `service://${triggerServiceName(restateName)}/`;

/** One subscription per enabled Kafka trigger, into that trigger's handler. */
export function desiredSubscriptions(
  metadata: Metadata,
  enabled: (triggerId: string) => boolean,
): DesiredSubscription[] {
  return metadata.triggers.flatMap((t) =>
    t.type === 'kafka' && enabled(t.id)
      ? [
          {
            triggerId: t.id,
            source: `kafka://${t.cluster}/${t.topic}`,
            sink: `${sinkPrefix(metadata.restateName)}${kafkaHandlerName(t.id)}`,
            // A stable group id lets a re-created subscription resume from committed offsets.
            options: { 'group.id': `wf.${metadata.name}.${t.id}`, 'auto.offset.reset': 'earliest' },
          },
        ]
      : [],
  );
}

export interface SubscriptionDiff {
  create: DesiredSubscription[];
  remove: Subscription[];
  keep: Map<string, Subscription>;
}

/** Converges live subscriptions owned by a workflow to the desired set (POST is not idempotent). */
export function diffSubscriptions(
  desired: DesiredSubscription[],
  live: Subscription[],
  prefix: string,
): SubscriptionDiff {
  const owned = live.filter((s) => s.sink.startsWith(prefix));
  const keep = new Map<string, Subscription>();
  const create: DesiredSubscription[] = [];
  const matched = new Set<string>();
  for (const d of desired) {
    const hit = owned.find((s) => !matched.has(s.id) && s.sink === d.sink && s.source === d.source);
    if (hit) {
      matched.add(hit.id);
      keep.set(d.triggerId, hit);
    } else create.push(d);
  }
  return { create, remove: owned.filter((s) => !matched.has(s.id)), keep };
}

export type ObservedStatus = 'active' | 'disabling' | 'disabled' | 'pending' | 'error';

/**
 * Observed state of a trigger. Deleting a subscription stops its consumer, but records Restate
 * already enqueued still run — so a disabled trigger reports `disabling` until the subscription
 * is gone, and "disabled" never means "nothing in flight".
 */
export function observedStatus(
  trigger: { type: 'rest' | 'kafka'; desired: boolean; lastError?: string | null },
  subscription: Subscription | undefined,
): ObservedStatus {
  if (trigger.type === 'rest') return trigger.desired ? 'active' : 'disabled';
  if (trigger.desired) return subscription ? 'active' : trigger.lastError ? 'error' : 'pending';
  return subscription ? 'disabling' : 'disabled';
}

export type RegistrationConflict = { code: PipelineErrorCode; message: string } | undefined;

/**
 * Version rules: a semantic version names one contract and, in immutable mode, one artifact.
 * Re-registering the same (version, contract, artifact) is idempotent. `dev` mode may replace.
 */
export function registrationConflict(
  mode: 'dev' | 'immutable',
  existing: { contractHash: string } | undefined,
  liveArtifacts: string[],
  incoming: { contractHash: string; artifactDigest: string },
): RegistrationConflict {
  if (mode === 'dev') return undefined;
  if (existing && existing.contractHash !== incoming.contractHash)
    return {
      code: 'VERSION_CONTRACT_CONFLICT',
      message: 'this version is registered with a different contract; bump the version',
    };
  if (liveArtifacts.some((a) => a !== incoming.artifactDigest))
    return {
      code: 'VERSION_ARTIFACT_CONFLICT',
      message: 'this version is deployed from a different artifact; bump the version',
    };
  return undefined;
}
