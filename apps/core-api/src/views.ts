import type { DeploymentView } from '@ai-pipeline/api-contract/deployments';
import type { RunView } from '@ai-pipeline/api-contract/runs';
import type { TriggerView } from '@ai-pipeline/api-contract/triggers';
import type { WorkflowDetail, WorkflowSummary } from '@ai-pipeline/api-contract/workflows';
import type { Dependency } from '@ai-pipeline/metadata/metadata';
import { observedStatus } from './domain/reconcile.js';
import { mapStatus, type InvocationRow, type RunState } from './restate/invocations.js';
import type { Subscription } from './restate/admin.js';
import type { Definition, DefinitionVersion } from './store/definitions.js';
import type { Deployment } from './store/deployments.js';
import type { TriggerRecord } from './store/triggers.js';

/**
 * Every mapping from an internal record to a wire view, in one place.
 *
 * These were previously written inline in the route handlers, which is how the same deployment
 * ended up described three slightly different ways. The API contract types are the check: a field
 * the schema does not know cannot be returned, and a field it requires cannot be forgotten.
 */

/** Postgres gives `Date`; the wire wants ISO-8601. Converted here, not by the serializer. */
const iso = (value: Date): string => value.toISOString();

export function toTriggerView(
  record: TriggerRecord,
  subscription: Subscription | undefined,
): TriggerView {
  const definition = record.definition;
  return {
    id: record.triggerId,
    type: record.type,
    ...(definition.type === 'kafka'
      ? { source: `kafka://${definition.cluster}/${definition.topic}` }
      : {}),
    desiredEnabled: record.desiredEnabled,
    observedStatus: observedStatus(
      { type: record.type, desired: record.desiredEnabled, lastError: record.lastError },
      subscription,
    ),
    ...(subscription ? { subscriptionId: subscription.id } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

export function toDeploymentView(deployment: Deployment, inFlight: number): DeploymentView {
  return {
    deploymentId: deployment.deploymentId,
    name: deployment.name,
    version: deployment.version,
    endpoint: deployment.endpoint,
    artifactDigest: deployment.artifactDigest,
    mode: deployment.mode,
    status: deployment.status,
    registeredAt: iso(deployment.registeredAt),
    ...(deployment.drainedAt ? { drainedAt: iso(deployment.drainedAt) } : {}),
    inFlight,
  };
}

export function toWorkflowSummary(
  definition: Definition,
  activeDeployment: string | undefined,
  triggers: TriggerView[],
): WorkflowSummary {
  return {
    name: definition.name,
    kind: definition.kind,
    version: definition.version,
    restateName: definition.restateName,
    visibility: definition.visibility,
    description: definition.description,
    ...(activeDeployment ? { activeDeployment } : {}),
    triggers,
    dependencies: definition.metadata.dependencies,
  };
}

export function toWorkflowDetail(parts: {
  definition: Definition;
  versions: DefinitionVersion[];
  deployments: Deployment[];
  dependencies: Dependency[];
  triggers: TriggerView[];
}): WorkflowDetail {
  const { definition } = parts;
  return {
    name: definition.name,
    kind: definition.kind,
    version: definition.version,
    restateName: definition.restateName,
    visibility: definition.visibility,
    description: definition.description,
    config: definition.metadata.config,
    schemas: definition.schemas,
    contractHash: definition.contractHash,
    triggers: parts.triggers,
    dependencies: parts.dependencies,
    versions: parts.versions.map((v) => ({
      version: v.version,
      contractHash: v.contractHash,
      registeredAt: iso(v.registeredAt),
    })),
    deployments: parts.deployments.map((d) => ({
      deploymentId: d.deploymentId,
      version: d.version,
      status: d.status,
      mode: d.mode,
      endpoint: d.endpoint,
      artifactDigest: d.artifactDigest,
      registeredAt: iso(d.registeredAt),
    })),
  };
}

export function toRunView(
  row: InvocationRow,
  workflow: string,
  state: RunState | undefined,
): RunView {
  const status = mapStatus(row);
  const error =
    status === 'completed' ? undefined : (row.completion_failure ?? row.last_failure ?? undefined);
  return {
    runId: row.target_service_key,
    invocationId: row.id,
    workflow,
    ...(state?.version ? { workflowVersion: state.version } : {}),
    ...(row.pinned_deployment_id ? { deploymentId: row.pinned_deployment_id } : {}),
    status,
    restateStatus: row.status,
    ...(state?.trigger ? { trigger: state.trigger } : {}),
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    ...(error ? { error } : {}),
  };
}
