import type { TriggerView } from '@ai-pipeline/api-contract/triggers';
import { notFound } from '../errors.js';
import type { Subscription } from '../restate/admin.js';
import type { Catalogue } from '../store/store.js';
import { toTriggerView } from '../views.js';
import type { ControlPlane } from './deps.js';
import {
  desiredSubscriptions,
  diffSubscriptions,
  observedStatus,
  sinkPrefix,
} from './reconcile.js';

/**
 * Trigger state management: the catalogue holds what an operator wants, Restate holds what is
 * actually consuming, and this module converges the two.
 */

/**
 * Trigger state with observed status read live from Restate.
 *
 * `subscriptions` is the global subscription list. Pass it when views are being built for more than
 * one unit: Restate has no per-service subscription endpoint, so every call otherwise fetches the
 * same global list again — one HTTP round trip per unit listed.
 */
export async function triggerViews(
  cp: ControlPlane,
  catalogue: Catalogue,
  name: string,
  subscriptions?: Subscription[],
): Promise<TriggerView[]> {
  const definition = await catalogue.definitions.current(name);
  if (!definition) throw notFound(`workflow ${name}`);
  const records = await catalogue.triggers.list(name);
  const prefix = sinkPrefix(definition.restateName);
  const live = (subscriptions ?? (await cp.admin.listSubscriptions())).filter((s) =>
    s.sink.startsWith(prefix),
  );
  const sinks = desiredSubscriptions(definition.metadata, () => true);
  return records.map((record) =>
    toTriggerView(record, subscriptionFor(record.triggerId, sinks, live)),
  );
}

/** The lock a reconcile — or anything that ends in one, such as a registration — must hold. */
export const reconcileLock = (name: string): string => `reconcile:${name}`;

/** Converges Restate subscriptions to the catalogue's desired state; records the outcome. */
export async function reconcileTriggers(cp: ControlPlane, name: string): Promise<TriggerView[]> {
  // POST /subscriptions is not idempotent: concurrent reconciles must not both create.
  return cp.store.withLock([reconcileLock(name)], (locked) => reconcileWithin(cp, locked, name));
}

/** The body of a reconcile, for a caller that already holds `reconcileLock(name)`. */
export async function reconcileWithin(
  cp: ControlPlane,
  catalogue: Catalogue,
  name: string,
): Promise<TriggerView[]> {
  const definition = await catalogue.definitions.current(name);
  if (!definition) throw notFound(`workflow ${name}`);
  const records = await catalogue.triggers.list(name);
  const desiredFlag = new Map(records.map((r) => [r.triggerId, r.desiredEnabled]));
  const desired = desiredSubscriptions(definition.metadata, (id) => desiredFlag.get(id) ?? true);
  const prefix = sinkPrefix(definition.restateName);
  const diff = diffSubscriptions(desired, await cp.admin.listSubscriptions(), prefix);

  const errors = new Map<string, string>();
  for (const subscription of diff.remove) await cp.admin.deleteSubscription(subscription.id);
  // Idempotent; covers a Restate whose metadata was reset while core-api kept running.
  if (diff.create.length > 0 && cp.kafka)
    await cp.admin.ensureKafkaCluster(cp.kafka.cluster, cp.kafka.bootstrapServers);
  for (const create of diff.create) {
    try {
      diff.keep.set(
        create.triggerId,
        await cp.admin.createSubscription(create.source, create.sink, create.options),
      );
    } catch (error) {
      errors.set(create.triggerId, (error as Error).message.slice(0, 500));
    }
  }

  const live = await cp.admin.listSubscriptions();
  const owned = live.filter((s) => s.sink.startsWith(prefix));
  const sinks = desiredSubscriptions(definition.metadata, () => true);
  for (const record of records) {
    const subscription =
      diff.keep.get(record.triggerId) ?? subscriptionFor(record.triggerId, sinks, owned);
    const status = observedStatus(
      {
        type: record.type,
        desired: record.desiredEnabled,
        lastError: errors.get(record.triggerId),
      },
      subscription,
    );
    await catalogue.triggers.setObserved(name, record.triggerId, {
      subscriptionId: subscription?.id ?? null,
      status,
      error: errors.get(record.triggerId) ?? null,
    });
  }
  return triggerViews(cp, catalogue, name, live);
}

export async function setTriggerEnabled(
  cp: ControlPlane,
  name: string,
  triggerId: string,
  enabled: boolean,
): Promise<TriggerView> {
  // Inside the lock: writing the desired state and converging to it is one operation, and a
  // concurrent deploy must not re-sync the triggers between the two halves.
  return cp.store.withLock([reconcileLock(name)], async (catalogue) => {
    const updated = await catalogue.triggers.setDesired(name, triggerId, enabled);
    if (!updated) throw notFound(`trigger ${name}/${triggerId}`);
    const view = (await reconcileWithin(cp, catalogue, name)).find((v) => v.id === triggerId);
    // A concurrent deploy can drop the trigger from the unit between the two statements above.
    if (!view) throw notFound(`trigger ${name}/${triggerId}`);
    return view;
  });
}

function subscriptionFor(
  triggerId: string,
  sinks: { triggerId: string; sink: string }[],
  live: Subscription[],
): Subscription | undefined {
  const sink = sinks.find((s) => s.triggerId === triggerId)?.sink;
  return sink ? live.find((s) => s.sink === sink) : undefined;
}
