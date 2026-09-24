import { z } from 'zod';
import { deploymentId, opaqueJson, runId, unitName } from './params.js';

/**
 * The runs surface. Restate is the run store — there is no run table — so these views are
 * assembled from `sys_invocation` plus the workflow state each run records at its start.
 */

export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'paused'] as const;
export const runStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatus>;

/**
 * A call this run is waiting on that is not making progress.
 *
 * A workflow waiting on a call is merely suspended, not failed, so the run reads `running` while
 * nothing is happening. Two statuses mean that: `backing-off` (failing and retrying — with the
 * uncapped `retry.llm` profile, a gateway outage stays here indefinitely) and `paused` (invocation
 * retries exhausted, journal kept, waiting for an operator). Without this the invocation that
 * actually needs attention is only visible in the Restate UI.
 */
export const blockedInvocation = z.object({
  invocationId: z.string(),
  /** Restate's own target string, e.g. `SummaryService/summarize`. */
  target: z.string(),
  /** Restate's invocation status, unmapped: `backing-off` or `paused`. Only `paused` is resumable. */
  restateStatus: z.string(),
  /** The most recent attempt's failure, truncated — these carry provider stack traces. */
  lastError: z.string().optional(),
});
export type BlockedInvocation = z.infer<typeof blockedInvocation>;

export const runView = z.object({
  runId: z.string(),
  invocationId: z.string(),
  workflow: unitName,
  /** The unit version that ran, recorded by the handler itself — not looked up afterwards. */
  workflowVersion: z.string().optional(),
  deploymentId: deploymentId.optional(),
  status: runStatus,
  /** Restate's own invocation status, unmapped, for operators comparing against the Restate UI. */
  restateStatus: z.string(),
  /** Where the run came from, as the handler recorded it. Absent until the handler has run. */
  trigger: opaqueJson.optional(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  /** Leads to the run's trace (the same id Langfuse shows when the overlay is running). */
  traceId: z.string().optional(),
  error: z.string().optional(),
  /** Present once the run has completed successfully. */
  output: opaqueJson.optional(),
  /**
   * Calls this run is waiting on that are not progressing. Only on a single-run read: collecting it
   * per row would put one query per run on the list path.
   */
  blocked: z.array(blockedInvocation).optional(),
});
export type RunView = z.infer<typeof runView>;

export const runList = z.object({
  runs: z.array(runView),
  nextCursor: z.string().optional(),
});
export type RunList = z.infer<typeof runList>;

export const runQuery = z.strictObject({
  workflow: unitName.optional(),
  status: runStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type RunQuery = z.infer<typeof runQuery>;

export const runParams = z.object({ workflow: unitName, runId });

export const runCancelling = z.object({
  runId: z.string(),
  invocationId: z.string(),
  status: z.literal('cancellation_requested'),
});
export type RunCancelling = z.infer<typeof runCancelling>;

/**
 * Resuming a paused run.
 *
 * Runs pause rather than fail when their retries are exhausted — an LLM gateway outage should not
 * lose work — so resuming one is a routine operation, not an escape hatch. Without it a paused run
 * could only be revived with the Restate CLI.
 */
export const runResuming = z.object({
  runId: z.string(),
  /** The invocation that was resumed: the run itself, or the blocked call named in the request. */
  invocationId: z.string(),
  status: z.literal('resume_requested'),
});
export type RunResuming = z.infer<typeof runResuming>;

/**
 * Which invocation to resume. Omitted means the run's own — what `blocked` reports is a *call* the
 * run is waiting on, and resuming the waiting parent would do nothing.
 */
export const runResumeBody = z.strictObject({ invocationId: z.string().max(200).optional() });
export type RunResumeBody = z.infer<typeof runResumeBody>;

/**
 * Killing a run. Unlike cancel, this does not let the handler unwind: no compensation runs and
 * children are abandoned. It is for a run that cancel cannot stop.
 */
export const runKilling = z.object({
  runId: z.string(),
  invocationId: z.string(),
  status: z.literal('kill_requested'),
});
export type RunKilling = z.infer<typeof runKilling>;
