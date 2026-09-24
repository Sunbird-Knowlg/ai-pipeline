import type {
  RunCancelling,
  RunKilling,
  RunList,
  RunQuery,
  RunResuming,
  RunView,
} from '@ai-pipeline/api-contract/runs';
import { createHash } from 'node:crypto';
import type { StartRunAccepted } from '@ai-pipeline/api-contract/workflows';
import { canonicalJson } from '@ai-pipeline/contracts/schemas';
import { apiRunId } from '@ai-pipeline/metadata/run-ids';
import { assert, notFound, PipelineError } from '../errors.js';
import { validator } from '../json-schema.js';
import {
  childInvocationsSql,
  encodeCursor,
  getRunSql,
  listRunsSql,
  runState,
  runTriggerSql,
  stateKey,
  type ChildInvocationRow,
  type InvocationRow,
} from '../restate/invocations.js';
import type { Definition } from '../store/definitions.js';
import { toBlockedInvocation, toRunView } from '../views.js';
import type { ControlPlane } from './deps.js';

/**
 * The run lifecycle. Restate owns execution and history; this module owns the rules about what may
 * be started and the translation between catalogue names and Restate service names.
 */

/**
 * Starting a run through the REST trigger.
 *
 * The preconditions are checked in the order that gives a caller the most useful refusal: is this
 * thing invocable at all, is its REST trigger on, is anything actually deployed, and only then does
 * the input get validated against the version's catalogued schema.
 *
 * The trigger context is built here, never taken from the request: a caller must not be able to
 * claim a run came from somewhere it did not.
 */
export async function startRun(
  cp: ControlPlane,
  name: string,
  input: unknown,
  idempotencyKey?: string,
): Promise<StartRunAccepted> {
  const definition = await cp.store.definitions.current(name);
  if (!definition) throw notFound(`workflow ${name}`);
  assert(
    definition.kind === 'workflow' && definition.visibility === 'public',
    'NOT_INVOCABLE',
    `${definition.name} is not a public workflow`,
    409,
  );

  const triggers = await cp.store.triggers.list(definition.name);
  const rest = triggers.find((t) => t.type === 'rest');
  assert(rest, 'NO_REST_TRIGGER', `${definition.name} has no REST trigger`, 409);
  assert(
    rest.desiredEnabled,
    'TRIGGER_DISABLED',
    `the REST trigger of ${definition.name} is disabled`,
    409,
  );

  const deployments = await cp.store.deployments.list(definition.name);
  assert(
    deployments.some((d) => d.status === 'active'),
    'NOT_DEPLOYED',
    `${definition.name} has no active deployment`,
    409,
  );

  validateInput(definition, input);

  const inputDigest = requestDigest(input);
  const runId = apiRunId(definition.name, idempotencyKey);
  const submission = await cp.ingress.submitWorkflow(definition.restateName, runId, {
    input,
    trigger: {
      type: 'rest',
      id: rest.triggerId,
      receivedAt: Date.now(),
      ...(idempotencyKey ? { idempotencyKey, inputDigest } : {}),
    },
  });
  // An idempotency key promises "this is the same request", and Restate answered that it has seen
  // this one before. If the body is not in fact the same, saying 202 would drop the new work
  // silently — so the caller is told instead.
  if (submission.status === 'PreviouslyAccepted' && idempotencyKey)
    await assertSameRequest(cp, definition, runId, inputDigest);
  return { runId, invocationId: submission.invocationId, status: submission.status };
}

/** Digest of the canonical input, so key order in the JSON does not make two requests differ. */
const requestDigest = (input: unknown): string =>
  createHash('sha256').update(canonicalJson(input)).digest('hex').slice(0, 32);

/**
 * Refuses a reused key that carries a different body — when it can tell.
 *
 * The comparison is against what the run itself recorded, so it needs no storage of its own: every
 * workflow writes its trigger context to workflow state as its first act. A run whose handler has
 * not reached that point yet — or one started before this field existed — records nothing to
 * compare, and the call is allowed through rather than refused on a guess.
 *
 * So this is **best-effort detection of a client bug, not a guarantee**, and deliberately so. The
 * two alternatives are worse:
 *
 * - failing closed until the evidence exists would answer 5xx to a client retrying in the first
 *   milliseconds, which is the common and *correct* use of an idempotency key;
 * - recording the digest here instead would mean a run table, and Restate is the run store.
 *
 * What the caller always gets is honest: `PreviouslyAccepted` says this key already has a run, never
 * that the body it just sent is the one running.
 */
async function assertSameRequest(
  cp: ControlPlane,
  definition: Definition,
  runId: string,
  inputDigest: string,
): Promise<void> {
  const recorded = await cp.admin.query<{ value_utf8: string | null }>(
    runTriggerSql(definition.restateName, runId),
  );
  const trigger = recorded[0]?.value_utf8;
  if (!trigger) return;
  let previous: string | undefined;
  try {
    previous = (JSON.parse(trigger) as { inputDigest?: string }).inputDigest;
  } catch {
    return;
  }
  if (previous !== undefined && previous !== inputDigest)
    throw new PipelineError(
      'IDEMPOTENCY_KEY_REUSED',
      `this Idempotency-Key already started run ${runId} with a different input; use a new key`,
      409,
    );
}

/** Validated against the schema of the version that will run, not the newest one registered. */
function validateInput(definition: Definition, input: unknown): void {
  const key = `${definition.name}@${definition.version}#${definition.contractHash}`;
  const validate = validator(key, definition.schemas.input);
  if (validate(input)) return;
  const detail = (validate.errors ?? [])
    .slice(0, 10)
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
  throw new PipelineError(
    'INVALID_INPUT',
    `input does not match ${definition.name} ${definition.version}: ${detail}`,
    400,
  );
}

export async function listRuns(cp: ControlPlane, query: RunQuery): Promise<RunList> {
  const definitions = (await cp.store.definitions.listCurrent('workflow')).filter(
    (d) => !query.workflow || d.name === query.workflow,
  );
  if (query.workflow && definitions.length === 0) throw notFound(`workflow ${query.workflow}`);
  if (definitions.length === 0) return { runs: [] };

  const byRestateName = new Map(definitions.map((d) => [d.restateName, d.name]));
  const rows = await cp.admin.query<InvocationRow>(
    listRunsSql({
      services: [...byRestateName.keys()],
      status: query.status,
      limit: query.limit,
      cursor: query.cursor,
    }),
  );
  // One extra row was requested: its presence is what says there is another page.
  const page = rows.slice(0, query.limit);
  const state = await runState(cp.admin, page);
  return {
    runs: page.map((row) =>
      toRunView(row, byRestateName.get(row.target_service_name)!, state.get(stateKey(row))),
    ),
    ...(rows.length > query.limit ? { nextCursor: encodeCursor(page[page.length - 1]!) } : {}),
  };
}

export async function getRun(cp: ControlPlane, name: string, runId: string): Promise<RunView> {
  const { row, definition } = await findRun(cp, name, runId);
  const state = await runState(cp.admin, [row]);
  const view = toRunView(row, definition.name, state.get(stateKey(row)));
  if (view.status === 'completed')
    view.output = await cp.ingress.workflowOutput(definition.restateName, runId);
  else {
    // A run waiting on a stuck call reads `running`, because waiting is not failing. Surfacing the
    // call is what makes it diagnosable, and a paused one recoverable — `resumeRun` takes one of
    // these ids. One extra query, and only here: `listRuns` must not pay it per row.
    const blocked = (await blockedChildren(cp, row.id)).map(toBlockedInvocation);
    if (blocked.length > 0) view.blocked = blocked;
  }
  return view;
}

/**
 * The calls a run is waiting on that are not progressing.
 *
 * `backing-off` as well as `paused`, because with the uncapped `retry.llm` profile a gateway outage
 * leaves a service retrying forever rather than exhausting its attempts — so `backing-off` is the
 * state an operator actually finds, and reporting only `paused` would answer "why is this run
 * stuck?" with silence. The other in-flight statuses are ordinary progress.
 */
const NOT_PROGRESSING = new Set(['backing-off', 'paused']);

async function blockedChildren(
  cp: ControlPlane,
  invocationId: string,
): Promise<ChildInvocationRow[]> {
  const children = await cp.admin.query<ChildInvocationRow>(childInvocationsSql(invocationId));
  return children.filter((child) => NOT_PROGRESSING.has(child.status));
}

export async function cancelRun(
  cp: ControlPlane,
  name: string,
  runId: string,
): Promise<RunCancelling> {
  const { row } = await findRun(cp, name, runId);
  const outcome = await cp.admin.cancelInvocation(row.id);
  assert(outcome !== 'not_found', 'NOT_FOUND', 'run not found', 404);
  assert(outcome !== 'completed', 'RUN_COMPLETED', 'the run has already completed', 409);
  return { runId, invocationId: row.id, status: 'cancellation_requested' };
}

/**
 * Killing a run: no unwinding, no compensation, children abandoned. For a run that cancel cannot
 * stop — cancel asks the handler to finish, kill does not.
 */
export async function killRun(cp: ControlPlane, name: string, runId: string): Promise<RunKilling> {
  const { row } = await findRun(cp, name, runId);
  const outcome = await cp.admin.killInvocation(row.id);
  assert(outcome !== 'not_found', 'NOT_FOUND', 'run not found', 404);
  assert(outcome !== 'completed', 'RUN_COMPLETED', 'the run has already completed', 409);
  return { runId, invocationId: row.id, status: 'kill_requested' };
}

/**
 * Resuming a paused invocation of a run.
 *
 * Runs pause instead of failing when their retries run out, which is deliberate: an LLM gateway
 * outage should not destroy a run's journal. That choice only works if what paused can be resumed
 * once the cause is fixed — and usually what paused is not the workflow but a service it called.
 * Restate pauses and resumes individual invocations, so `invocationId` names which one; it must be
 * the run's own or one of the calls `getRun` reports in `blocked`, so this cannot be used to reach
 * an arbitrary invocation through a run the caller happens to know.
 */
export async function resumeRun(
  cp: ControlPlane,
  name: string,
  runId: string,
  invocationId?: string,
): Promise<RunResuming> {
  const { row } = await findRun(cp, name, runId);
  const target = await resumeTarget(cp, row, invocationId);
  const outcome = await cp.admin.resumeInvocation(target);
  assert(outcome !== 'not_found', 'NOT_FOUND', 'invocation not found', 404);
  assert(
    outcome !== 'not_paused',
    'RUN_NOT_RESUMABLE',
    target === row.id
      ? 'only a paused invocation can be resumed; this run is running or has completed. If it is waiting on a paused call, resume that call: its id is in the run\'s "blocked"'
      : 'that call is no longer paused',
    409,
  );
  return { runId, invocationId: target, status: 'resume_requested' };
}

async function resumeTarget(
  cp: ControlPlane,
  row: InvocationRow,
  invocationId?: string,
): Promise<string> {
  if (!invocationId || invocationId === row.id) return row.id;
  const children = await cp.admin.query<ChildInvocationRow>(childInvocationsSql(row.id));
  assert(
    children.some((child) => child.id === invocationId),
    'NOT_FOUND',
    `${invocationId} is not a call of run ${row.target_service_key}`,
    404,
  );
  return invocationId;
}

async function findRun(
  cp: ControlPlane,
  name: string,
  runId: string,
): Promise<{ row: InvocationRow; definition: Definition }> {
  const definition = await cp.store.definitions.current(name);
  if (definition?.kind !== 'workflow') throw notFound(`workflow ${name}`);
  const [row] = await cp.admin.query<InvocationRow>(getRunSql(definition.restateName, runId));
  if (!row) throw notFound(`run ${runId}`);
  return { row, definition };
}
