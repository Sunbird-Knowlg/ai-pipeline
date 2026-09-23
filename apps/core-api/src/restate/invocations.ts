import { RUN_STATUSES, type RunStatus } from '@ai-pipeline/api-contract/runs';
import { z } from 'zod';
import { PipelineError } from '../errors.js';
import type { RestateAdminPort } from './admin.js';
import { quote, RESTATE_NAME, RUN_KEY } from './sql.js';

/**
 * Reading runs out of Restate. Restate is the run store — there is no run table — so this module
 * owns the introspection SQL against `sys_invocation` and `state`, and the mapping from Restate's
 * invocation status to the API's run status.
 *
 * DataFusion takes no bind parameters, so every interpolated value is either pattern-validated here
 * or quoted with `quote()`.
 */

export interface InvocationRow {
  id: string;
  target_service_name: string;
  target_service_key: string;
  status: string;
  completion_result?: string | null;
  completion_failure?: string | null;
  last_failure?: string | null;
  created_at: string;
  completed_at?: string | null;
  pinned_deployment_id?: string | null;
  trace_id?: string | null;
}

/** Workflow K/V state a handler records at its start. */
export interface RunState {
  trigger?: unknown;
  version?: string;
}

const COLUMNS =
  'id, target_service_name, target_service_key, status, completion_result, completion_failure, last_failure, created_at, completed_at, pinned_deployment_id, trace_id';

/** Restate invocation status → the API's run status. Cancellation is a terminal `[409] Cancelled`. */
export function mapStatus(
  row: Pick<InvocationRow, 'status' | 'completion_result' | 'completion_failure'>,
): RunStatus {
  if (row.status === 'paused') return 'paused';
  if (row.status !== 'completed') return 'running';
  if (row.completion_result === 'success') return 'completed';
  return /^\[409\] Cancel/i.test(row.completion_failure ?? '') ? 'cancelled' : 'failed';
}

function statusPredicate(status: RunStatus): string {
  switch (status) {
    case 'running':
      return "status NOT IN ('completed', 'paused')";
    case 'paused':
      return "status = 'paused'";
    case 'completed':
      return "status = 'completed' AND completion_result = 'success'";
    case 'cancelled':
      return "status = 'completed' AND completion_result = 'failure' AND completion_failure LIKE '[409] Cancel%'";
    case 'failed':
      return "status = 'completed' AND completion_result = 'failure' AND (completion_failure IS NULL OR completion_failure NOT LIKE '[409] Cancel%')";
  }
}

const cursorSchema = z.tuple([z.iso.datetime(), z.string().regex(/^inv_[A-Za-z0-9]{1,100}$/)]);

export function encodeCursor(row: Pick<InvocationRow, 'created_at' | 'id'>): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { createdAt, id };
  } catch {
    throw new PipelineError('INVALID_CURSOR', 'cursor is not valid', 400);
  }
}

/** Keyset-paginated `run` invocations of the given workflows, newest first. */
export function listRunsSql(opts: {
  services: string[];
  status?: RunStatus;
  limit: number;
  cursor?: string;
}): string {
  for (const service of opts.services)
    if (!RESTATE_NAME.test(service))
      throw new PipelineError('INVALID_REQUEST', 'invalid workflow name', 400);
  const where = [
    `target_service_name IN (${opts.services.map(quote).join(', ')})`,
    "target_handler_name = 'run'",
  ];
  if (opts.status) where.push(`(${statusPredicate(opts.status)})`);
  if (opts.cursor) {
    const { createdAt, id } = decodeCursor(opts.cursor);
    const ts = `CAST(${quote(createdAt)} AS TIMESTAMP)`;
    where.push(`(created_at < ${ts} OR (created_at = ${ts} AND id < ${quote(id)}))`);
  }
  return `SELECT ${COLUMNS} FROM sys_invocation WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${opts.limit + 1}`;
}

export function getRunSql(service: string, runId: string): string {
  if (!RESTATE_NAME.test(service) || !RUN_KEY.test(runId))
    throw new PipelineError('INVALID_REQUEST', 'invalid workflow or run id', 400);
  return `SELECT ${COLUMNS} FROM sys_invocation WHERE target_service_name = ${quote(service)} AND target_service_key = ${quote(runId)} AND target_handler_name = 'run' ORDER BY created_at DESC LIMIT 1`;
}

/** In-flight invocations still pinned to a deployment (they must finish there). */
export function inFlightSql(deploymentId: string): string {
  return `SELECT count(*) AS n FROM sys_invocation WHERE pinned_deployment_id = ${quote(deploymentId)} AND status <> 'completed'`;
}

/**
 * In-flight counts for many deployments at once, as one grouped query.
 *
 * The listing endpoint needs a count per deployment, and asking per deployment costs one round trip
 * each — which with accumulated build history reached dozens of queries for a single request.
 * Deployments with nothing pinned to them are absent from the result, so callers default to 0.
 */
export function inFlightByDeploymentSql(deploymentIds: string[]): string {
  const ids = deploymentIds.map(quote).join(', ');
  return `SELECT pinned_deployment_id AS id, count(*) AS n FROM sys_invocation WHERE pinned_deployment_id IN (${ids}) AND status <> 'completed' GROUP BY pinned_deployment_id`;
}

/** The `trigger` and `version` state the workflows record at their start, keyed `service/runId`. */
export async function runState(
  admin: Pick<RestateAdminPort, 'query'>,
  rows: InvocationRow[],
): Promise<Map<string, RunState>> {
  const state = new Map<string, RunState>();
  if (rows.length === 0) return state;
  const services = [...new Set(rows.map((r) => r.target_service_name))].map(quote).join(', ');
  const keys = rows.map((r) => quote(r.target_service_key)).join(', ');
  const values = await admin.query<{
    service_name: string;
    service_key: string;
    key: string;
    value_utf8: string | null;
  }>(
    `SELECT service_name, service_key, key, value_utf8 FROM state WHERE service_name IN (${services}) AND service_key IN (${keys}) AND key IN ('trigger', 'version')`,
  );
  for (const value of values) {
    const id = `${value.service_name}/${value.service_key}`;
    const entry = state.get(id) ?? {};
    const parsed = value.value_utf8 ? safeJson(value.value_utf8) : undefined;
    if (value.key === 'trigger') entry.trigger = parsed;
    if (value.key === 'version' && typeof parsed === 'string') entry.version = parsed;
    state.set(id, entry);
  }
  return state;
}

export const stateKey = (row: InvocationRow): string =>
  `${row.target_service_name}/${row.target_service_key}`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export { RUN_STATUSES };
