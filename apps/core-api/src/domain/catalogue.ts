import type { UnitKind } from '@ai-pipeline/api-contract/params';
import type { WorkflowDetail, WorkflowSummary } from '@ai-pipeline/api-contract/workflows';
import { notFound } from '../errors.js';
import { toWorkflowDetail, toWorkflowSummary } from '../views.js';
import type { ControlPlane } from './deps.js';
import { triggerViews } from './triggers.js';

/**
 * The catalogue read models. They were assembled inline in two route handlers, which is why the
 * same unit was described with slightly different field sets depending on the endpoint.
 */

export async function listUnits(cp: ControlPlane, kind?: UnitKind): Promise<WorkflowSummary[]> {
  const [definitions, deployments] = await Promise.all([
    cp.store.definitions.listCurrent(kind),
    cp.store.deployments.list(),
  ]);
  return Promise.all(
    definitions.map(async (definition) =>
      toWorkflowSummary(
        definition,
        deployments.find((d) => d.name === definition.name && d.status === 'active')?.deploymentId,
        await triggerViews(cp, definition.name),
      ),
    ),
  );
}

export async function describeUnit(cp: ControlPlane, name: string): Promise<WorkflowDetail> {
  const definition = await cp.store.definitions.current(name);
  if (!definition) throw notFound(`workflow ${name}`);
  const [versions, deployments, dependencies, triggers] = await Promise.all([
    cp.store.definitions.versions(definition.name),
    cp.store.deployments.list(definition.name),
    cp.store.dependencies.list(definition.name, definition.version),
    triggerViews(cp, definition.name),
  ]);
  return toWorkflowDetail({ definition, versions, deployments, dependencies, triggers });
}
