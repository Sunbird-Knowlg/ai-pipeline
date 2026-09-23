import { describe, expect, it } from 'vitest';
import type { PipelineError } from '../errors.js';
import {
  definitionOf,
  deploymentOf,
  fakeControlPlane,
  metadataOf,
  triggerOf,
} from '../testing/restate.js';
import { cancelRun, getRun, killRun, listRuns, resumeRun, startRun } from './runs.js';

/**
 * The run-start precondition chain, which used to live inside the route handler and had no tests.
 * Each refusal is a distinct wire code the CLI and the e2e suites rely on.
 */

/** A catalogue with content-enrichment deployed and its REST trigger on. */
const ready = () =>
  fakeControlPlane({
    seed: {
      definitions: [definitionOf()],
      deployments: [deploymentOf({ status: 'active' })],
      triggers: [triggerOf()],
    },
  });

describe('startRun', () => {
  it('submits the run with a trigger context the caller cannot forge', async () => {
    const cp = ready();
    const accepted = await startRun(cp, 'content-enrichment', { text: 'hello' }, 'key-1');

    expect(accepted).toMatchObject({ status: 'Accepted', invocationId: 'inv_1' });
    expect(accepted.runId).toMatch(/^api_[0-9a-f]{32}$/);

    const [submission] = cp.ingress.submissions;
    expect(submission).toMatchObject({ restateName: 'ContentEnrichment', runId: accepted.runId });
    expect(submission!.request).toMatchObject({
      input: { text: 'hello' },
      trigger: { type: 'rest', id: 'api', idempotencyKey: 'key-1' },
    });
  });

  it('records a digest of the input, so a reused key can be checked against it', async () => {
    const cp = ready();
    await startRun(cp, 'content-enrichment', { text: 'hello' }, 'key-1');
    expect(cp.ingress.submissions[0]!.request).toMatchObject({
      trigger: { inputDigest: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
  });

  it('digests the input canonically, so key order in the JSON is not a different request', async () => {
    const cp = ready();
    await startRun(cp, 'content-enrichment', { text: 'a', n: 1 }, 'key-1');
    await startRun(cp, 'content-enrichment', { n: 1, text: 'a' }, 'key-2');
    const digests = cp.ingress.submissions.map(
      (s) => (s.request as { trigger: { inputDigest: string } }).trigger.inputDigest,
    );
    expect(digests[0]).toBe(digests[1]);
  });

  it('does not record a digest when there is no key to bind it to', async () => {
    const cp = ready();
    await startRun(cp, 'content-enrichment', { text: 'hello' });
    expect(cp.ingress.submissions[0]!.request).not.toMatchObject({
      trigger: { inputDigest: expect.anything() },
    });
  });

  describe('a reused Idempotency-Key', () => {
    /** Restate has seen this run before, and the run recorded the trigger it started with. */
    const seen = (recordedTrigger: unknown) => {
      const cp = ready();
      cp.ingress.submitWorkflow = async () => ({
        invocationId: 'inv_1',
        status: 'PreviouslyAccepted',
      });
      cp.admin.rows =
        recordedTrigger === undefined ? [] : [{ value_utf8: JSON.stringify(recordedTrigger) }];
      return cp;
    };

    it('is accepted when the body really is the same', async () => {
      const digest = await startRun(ready(), 'content-enrichment', { text: 'same' }, 'k').then(
        async () => {
          const probe = ready();
          await startRun(probe, 'content-enrichment', { text: 'same' }, 'k');
          return (probe.ingress.submissions[0]!.request as { trigger: { inputDigest: string } })
            .trigger.inputDigest;
        },
      );
      const cp = seen({ type: 'rest', id: 'api', inputDigest: digest });
      await expect(
        startRun(cp, 'content-enrichment', { text: 'same' }, 'k'),
      ).resolves.toMatchObject({ status: 'PreviouslyAccepted' });
    });

    it('is refused when it carries a different body, instead of dropping the new work', async () => {
      const cp = seen({ type: 'rest', id: 'api', inputDigest: 'f'.repeat(32) });
      await expect(
        startRun(cp, 'content-enrichment', { text: 'different' }, 'k'),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
    });

    it('is allowed through when the run has not recorded anything to compare yet', async () => {
      // The handler writes its trigger as its first act; a submit that arrives before it does has
      // nothing to check, and guessing would refuse a legitimate retry.
      await expect(
        startRun(seen(undefined), 'content-enrichment', { text: 'x' }, 'k'),
      ).resolves.toMatchObject({ status: 'PreviouslyAccepted' });
      await expect(
        startRun(seen({ type: 'rest', id: 'api' }), 'content-enrichment', { text: 'x' }, 'k'),
      ).resolves.toMatchObject({ status: 'PreviouslyAccepted' });
    });

    it('is not checked at all when no key was given', async () => {
      const cp = seen({ type: 'rest', id: 'api', inputDigest: 'f'.repeat(32) });
      await expect(startRun(cp, 'content-enrichment', { text: 'x' })).resolves.toMatchObject({
        status: 'PreviouslyAccepted',
      });
    });
  });

  it('derives the same run id from the same Idempotency-Key, and a fresh one without', async () => {
    const cp = ready();
    const first = await startRun(cp, 'content-enrichment', { text: 'a' }, 'key-1');
    const again = await startRun(cp, 'content-enrichment', { text: 'a' }, 'key-1');
    const keyless = await startRun(cp, 'content-enrichment', { text: 'a' });

    expect(again.runId).toBe(first.runId);
    expect(keyless.runId).not.toBe(first.runId);
  });

  it('404s on a unit the catalogue does not know', async () => {
    await expect(startRun(ready(), 'nope', { text: 'a' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a service, and a private workflow', async () => {
    const service = fakeControlPlane({
      seed: {
        definitions: [
          definitionOf({
            metadata: metadataOf({
              name: 'summary',
              kind: 'service',
              restateName: 'SummaryService',
            }),
            name: 'summary',
            kind: 'service',
          }),
        ],
      },
    });
    await expect(startRun(service, 'summary', {})).rejects.toMatchObject({
      code: 'NOT_INVOCABLE',
      statusCode: 409,
    });

    const private_ = fakeControlPlane({
      seed: { definitions: [definitionOf({ metadata: metadataOf({ visibility: 'private' }) })] },
    });
    await expect(startRun(private_, 'content-enrichment', {})).rejects.toMatchObject({
      code: 'NOT_INVOCABLE',
    });
  });

  it('refuses a workflow with no REST trigger', async () => {
    const cp = fakeControlPlane({
      seed: { definitions: [definitionOf()], deployments: [deploymentOf()], triggers: [] },
    });
    await expect(startRun(cp, 'content-enrichment', { text: 'a' })).rejects.toMatchObject({
      code: 'NO_REST_TRIGGER',
      statusCode: 409,
    });
  });

  it('refuses while the REST trigger is switched off', async () => {
    const cp = fakeControlPlane({
      seed: {
        definitions: [definitionOf()],
        deployments: [deploymentOf()],
        triggers: [triggerOf({ desiredEnabled: false })],
      },
    });
    await expect(startRun(cp, 'content-enrichment', { text: 'a' })).rejects.toMatchObject({
      code: 'TRIGGER_DISABLED',
      statusCode: 409,
    });
  });

  it('refuses when nothing is deployed', async () => {
    const cp = fakeControlPlane({
      seed: {
        definitions: [definitionOf()],
        deployments: [deploymentOf({ status: 'draining' })],
        triggers: [triggerOf()],
      },
    });
    await expect(startRun(cp, 'content-enrichment', { text: 'a' })).rejects.toMatchObject({
      code: 'NOT_DEPLOYED',
      statusCode: 409,
    });
  });

  it('validates input against the catalogued schema and says what failed', async () => {
    const cp = ready();
    const error = (await startRun(cp, 'content-enrichment', { wrong: true }).catch(
      (e: unknown) => e,
    )) as PipelineError;
    expect(error).toMatchObject({ code: 'INVALID_INPUT', statusCode: 400 });
    expect(error.message).toContain('content-enrichment 1.0.0');
    expect(cp.ingress.submissions).toHaveLength(0);
  });

  it('checks the preconditions before the input, so the most useful refusal wins', async () => {
    // Bad input *and* nothing deployed: the caller hears about the deployment first.
    const cp = fakeControlPlane({
      seed: { definitions: [definitionOf()], deployments: [], triggers: [triggerOf()] },
    });
    await expect(startRun(cp, 'content-enrichment', { wrong: true })).rejects.toMatchObject({
      code: 'NOT_DEPLOYED',
    });
  });
});

describe('listRuns', () => {
  const invocation = (id: string, createdAt: string) => ({
    id,
    target_service_name: 'ContentEnrichment',
    target_service_key: `api_${id}`,
    status: 'completed',
    completion_result: 'success',
    created_at: createdAt,
  });

  it('returns an empty page when the catalogue has no workflows', async () => {
    const cp = fakeControlPlane();
    await expect(listRuns(cp, { limit: 50 })).resolves.toEqual({ runs: [] });
  });

  it('404s on a named workflow it does not know', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    await expect(listRuns(cp, { workflow: 'nope', limit: 50 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('maps Restate service names back to catalogue names', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [invocation('inv_1', '2026-01-01T00:00:00.000Z')];

    const { runs, nextCursor } = await listRuns(cp, { limit: 50 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workflow: 'content-enrichment', status: 'completed' });
    expect(nextCursor).toBeUndefined();
  });

  it('pages: one row beyond the limit becomes a cursor, not a result', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [
      invocation('inv_2', '2026-01-02T00:00:00.000Z'),
      invocation('inv_1', '2026-01-01T00:00:00.000Z'),
    ];

    const { runs, nextCursor } = await listRuns(cp, { limit: 1 });
    expect(runs.map((r) => r.invocationId)).toEqual(['inv_2']);
    expect(nextCursor).toBeTypeOf('string');
  });
});

describe('getRun', () => {
  it('attaches the output only once the run has completed', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.ingress.output = { summary: 'done' };
    cp.admin.rows = [
      {
        id: 'inv_1',
        target_service_name: 'ContentEnrichment',
        target_service_key: 'api_1',
        status: 'completed',
        completion_result: 'success',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    await expect(getRun(cp, 'content-enrichment', 'api_1')).resolves.toMatchObject({
      status: 'completed',
      output: { summary: 'done' },
    });
  });

  it('404s on an unknown run', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [];
    await expect(getRun(cp, 'content-enrichment', 'api_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('cancelRun', () => {
  const row = {
    id: 'inv_1',
    target_service_name: 'ContentEnrichment',
    target_service_key: 'api_1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('asks Restate to cancel and reports the request as accepted', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [row];
    await expect(cancelRun(cp, 'content-enrichment', 'api_1')).resolves.toEqual({
      runId: 'api_1',
      invocationId: 'inv_1',
      status: 'cancellation_requested',
    });
  });

  it('distinguishes "already finished" from "never existed"', async () => {
    const finished = fakeControlPlane({
      seed: { definitions: [definitionOf()] },
      admin: { cancelInvocation: async () => 'completed' },
    });
    finished.admin.rows = [row];
    await expect(cancelRun(finished, 'content-enrichment', 'api_1')).rejects.toMatchObject({
      code: 'RUN_COMPLETED',
      statusCode: 409,
    });

    const gone = fakeControlPlane({
      seed: { definitions: [definitionOf()] },
      admin: { cancelInvocation: async () => 'not_found' },
    });
    gone.admin.rows = [row];
    await expect(cancelRun(gone, 'content-enrichment', 'api_1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('killRun', () => {
  const row = {
    id: 'inv_1',
    target_service_name: 'ContentEnrichment',
    target_service_key: 'api_1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('kills without waiting for the handler to unwind', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [row];
    await expect(killRun(cp, 'content-enrichment', 'api_1')).resolves.toEqual({
      runId: 'api_1',
      invocationId: 'inv_1',
      status: 'kill_requested',
    });
  });

  it('refuses a run that has already completed', async () => {
    const cp = fakeControlPlane({
      seed: { definitions: [definitionOf()] },
      admin: { killInvocation: async () => 'completed' },
    });
    cp.admin.rows = [row];
    await expect(killRun(cp, 'content-enrichment', 'api_1')).rejects.toMatchObject({
      code: 'RUN_COMPLETED',
      statusCode: 409,
    });
  });
});

describe('resumeRun', () => {
  const paused = {
    id: 'inv_1',
    target_service_name: 'ContentEnrichment',
    target_service_key: 'api_1',
    status: 'paused',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('resumes a paused run, which is the counterpart to pausing on exhausted retries', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [paused];
    await expect(resumeRun(cp, 'content-enrichment', 'api_1')).resolves.toEqual({
      runId: 'api_1',
      invocationId: 'inv_1',
      status: 'resume_requested',
    });
  });

  it('refuses a run that is not paused, and says why', async () => {
    const cp = fakeControlPlane({
      seed: { definitions: [definitionOf()] },
      admin: { resumeInvocation: async () => 'not_paused' },
    });
    cp.admin.rows = [paused];
    const error = (await resumeRun(cp, 'content-enrichment', 'api_1').catch(
      (e: unknown) => e,
    )) as PipelineError;
    expect(error).toMatchObject({ code: 'RUN_NOT_RESUMABLE', statusCode: 409 });
    expect(error.message).toMatch(/only a paused run can be resumed/);
  });

  it('404s on a run Restate does not know', async () => {
    const cp = fakeControlPlane({
      seed: { definitions: [definitionOf()] },
      admin: { resumeInvocation: async () => 'not_found' },
    });
    cp.admin.rows = [paused];
    await expect(resumeRun(cp, 'content-enrichment', 'api_1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('reports a paused run as `paused`, so an operator can find it to resume', async () => {
    const cp = fakeControlPlane({ seed: { definitions: [definitionOf()] } });
    cp.admin.rows = [paused];
    await expect(getRun(cp, 'content-enrichment', 'api_1')).resolves.toMatchObject({
      status: 'paused',
    });
  });
});
