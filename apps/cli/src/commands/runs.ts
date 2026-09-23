import type { RunCancelling, RunList, RunView } from '@ai-pipeline/api-contract/runs';
import type { StartRunAccepted, WorkflowList } from '@ai-pipeline/api-contract/workflows';
import type { CoreApi } from '../core-api.js';

export async function listUnits(api: CoreApi): Promise<WorkflowList> {
  return api<WorkflowList>('GET', '/v1/workflows');
}

export async function startRun(
  api: CoreApi,
  workflow: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<StartRunAccepted> {
  return api<StartRunAccepted>(
    'POST',
    `/v1/workflows/${encodeURIComponent(workflow)}/runs`,
    { input },
    idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  );
}

export async function listRuns(
  api: CoreApi,
  filters: { workflow?: string; status?: string } = {},
): Promise<RunList> {
  const query = new URLSearchParams();
  if (filters.workflow) query.set('workflow', filters.workflow);
  if (filters.status) query.set('status', filters.status);
  return api<RunList>('GET', `/v1/runs?${query.toString()}`);
}

export async function getRun(api: CoreApi, workflow: string, runId: string): Promise<RunView> {
  return api<RunView>(
    'GET',
    `/v1/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(runId)}`,
  );
}

export async function cancelRun(
  api: CoreApi,
  workflow: string,
  runId: string,
): Promise<RunCancelling> {
  return api<RunCancelling>(
    'POST',
    `/v1/runs/${encodeURIComponent(workflow)}/${encodeURIComponent(runId)}/cancel`,
  );
}
