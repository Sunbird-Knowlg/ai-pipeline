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

/**
 * Consumer settings every subscription gets, on top of its identity.
 *
 * Restate passes a subscription's options straight through to librdkafka, which is where this
 * belongs: the failure they exist for is the broker evicting Restate's consumer for a missed
 * heartbeat — `removing member … on heartbeat expiration` — after which it does not rejoin. The
 * subscription stays registered, so the trigger still reads `active` while the topic accumulates
 * records that never start a run. A few seconds of host stall was enough to trigger it.
 *
 * So the timeouts are widened rather than the eviction detected and repaired. The cost is that a
 * genuinely dead consumer holds its partitions for longer before a rebalance, which is the right
 * trade here: this pipeline values not dropping work far above rebalancing quickly.
 */
const CONSUMER_OPTIONS: Readonly<Record<string, string>> = {
  'auto.offset.reset': 'earliest',
  /** librdkafka defaults to 45s; a stalled host misses that, and the member is dropped. */
  'session.timeout.ms': '120000',
  /** Must stay well under a third of the session timeout. */
  'heartbeat.interval.ms': '10000',
  /** Headroom for a poll loop starved by whatever stalled the host in the first place. */
  'max.poll.interval.ms': '600000',
};

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
            options: { 'group.id': `wf.${metadata.name}.${t.id}`, ...CONSUMER_OPTIONS },
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

/**
 * Whether a live subscription is the one wanted, including how its consumer is configured.
 *
 * Options are part of the comparison because a subscription cannot be edited: if the desired
 * consumer settings change, the only way to apply them is to replace it. Matching on source and
 * sink alone means an existing subscription silently keeps whatever it was created with — which is
 * how the librdkafka timeouts above reached a newly created subscription and no other.
 *
 * The check is one-directional: Restate adds `client.id` of its own, and extra keys it sets are not
 * a reason to tear a working subscription down.
 */
const matches = (live: Subscription, desired: DesiredSubscription): boolean =>
  live.sink === desired.sink &&
  live.source === desired.source &&
  Object.entries(desired.options).every(([key, value]) => live.options[key] === value);

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
    const hit = owned.find((s) => !matched.has(s.id) && matches(s, d));
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
 *
 * `active` means Restate holds a subscription, which is all Restate can be asked. It is not the
 * same as "records are being consumed": a Restate consumer evicted from its Kafka group does not
 * rejoin, and the subscription outlives it. See docs/qa-report.md (P1-1) for how that presents and
 * how to recover from it.
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
