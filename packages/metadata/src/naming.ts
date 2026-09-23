/**
 * Restate naming derived from a unit's `restateName`. Both the control plane (building subscription
 * sinks) and the runtime (building the trigger service) must agree on these, so they live here
 * rather than being spelled out at each call site.
 */

/** The Restate service that receives a workflow's Kafka subscriptions. */
export function triggerServiceName(restateName: string): string {
  return `${restateName}Trigger`;
}

/** Handler of the trigger service that receives one Kafka trigger's subscription. */
export function kafkaHandlerName(triggerId: string): string {
  return `on${triggerId.replace(/(^|-)([a-z0-9])/g, (_, _dash: string, c: string) => c.toUpperCase())}`;
}
