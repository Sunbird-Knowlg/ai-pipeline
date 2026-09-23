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

/**
 * One page of runs.
 *
 * `limit` and `cursor` are part of this because the API pages: it answers at most 50 runs by
 * default and returns a `nextCursor`, which the CLI used to print and give no way to use — so
 * `pipeline runs` silently showed the first page and nothing said so.
 */
export async function listRuns(
  api: CoreApi,
  filters: { workflow?: string; status?: string; limit?: number; cursor?: string } = {},
): Promise<RunList> {
  const query = new URLSearchParams();
  if (filters.workflow) query.set('workflow', filters.workflow);
  if (filters.status) query.set('status', filters.status);
  if (filters.limit !== undefined) query.set('limit', String(filters.limit));
  if (filters.cursor) query.set('cursor', filters.cursor);
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
