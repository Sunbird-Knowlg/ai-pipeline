import type { TriggerView } from '@ai-pipeline/api-contract/triggers';
import { notFound } from '../errors.js';
import type { Subscription } from '../restate/admin.js';
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

/** Trigger state with observed status read live from Restate. */
export async function triggerViews(cp: ControlPlane, name: string): Promise<TriggerView[]> {
  const definition = await cp.store.definitions.current(name);
  if (!definition) throw notFound(`workflow ${name}`);
  const records = await cp.store.triggers.list(name);
  const live = await ownedSubscriptions(cp, definition.restateName);
  const sinks = desiredSubscriptions(definition.metadata, () => true);
  return records.map((record) =>
    toTriggerView(record, subscriptionFor(record.triggerId, sinks, live)),
  );
}

/** Converges Restate subscriptions to the catalogue's desired state; records the outcome. */
export async function reconcileTriggers(cp: ControlPlane, name: string): Promise<TriggerView[]> {
  // POST /subscriptions is not idempotent: concurrent reconciles must not both create.
  return cp.store.withLock(`reconcile:${name}`, () => reconcile(cp, name));
}

async function reconcile(cp: ControlPlane, name: string): Promise<TriggerView[]> {
  const definition = await cp.store.definitions.current(name);
  if (!definition) throw notFound(`workflow ${name}`);
  const records = await cp.store.triggers.list(name);
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

  const live = await ownedSubscriptions(cp, definition.restateName);
  const sinks = desiredSubscriptions(definition.metadata, () => true);
  for (const record of records) {
    const subscription =
      diff.keep.get(record.triggerId) ?? subscriptionFor(record.triggerId, sinks, live);
    const status = observedStatus(
      {
        type: record.type,
        desired: record.desiredEnabled,
        lastError: errors.get(record.triggerId),
      },
      subscription,
    );
    await cp.store.triggers.setObserved(name, record.triggerId, {
      subscriptionId: subscription?.id ?? null,
      status,
      error: errors.get(record.triggerId) ?? null,
    });
  }
  return triggerViews(cp, name);
}

export async function setTriggerEnabled(
  cp: ControlPlane,
  name: string,
  triggerId: string,
  enabled: boolean,
): Promise<TriggerView> {
  const updated = await cp.store.triggers.setDesired(name, triggerId, enabled);
  if (!updated) throw notFound(`trigger ${name}/${triggerId}`);
  const views = await reconcileTriggers(cp, name);
  return views.find((view) => view.id === triggerId)!;
}

/** Live subscriptions whose sink belongs to this workflow's trigger service. */
async function ownedSubscriptions(cp: ControlPlane, restateName: string): Promise<Subscription[]> {
  const prefix = sinkPrefix(restateName);
  return (await cp.admin.listSubscriptions()).filter((s) => s.sink.startsWith(prefix));
}

function subscriptionFor(
  triggerId: string,
  sinks: { triggerId: string; sink: string }[],
  live: Subscription[],
): Subscription | undefined {
  const sink = sinks.find((s) => s.triggerId === triggerId)?.sink;
  return sink ? live.find((s) => s.sink === sink) : undefined;
}
