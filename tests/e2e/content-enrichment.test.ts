import { readFileSync } from 'node:fs';
import type { ErrorEnvelope } from '@ai-pipeline/api-contract/errors';
import type { RunList, RunView } from '@ai-pipeline/api-contract/runs';
import type {
  StartRunAccepted,
  WorkflowDetail,
  WorkflowList,
} from '@ai-pipeline/api-contract/workflows';
import { describe, expect, it } from 'vitest';
import { api, compose, publish, restateSql, uniq, waitForRun } from './support.js';

const VERSION = JSON.parse(
  readFileSync('workflows/content-enrichment/metadata.json', 'utf8'),
).version;

const TEXT =
  'Restate is a durable execution engine. It journals every step of a handler so that, after a crash, ' +
  'the handler replays from the journal and resumes where it left off.';

describe('catalogue', () => {
  it('lists the workflow with both triggers and the private summary service', async () => {
    const { body } = await api<WorkflowList>('GET', '/v1/workflows');
    const workflow = body.workflows.find((w) => w.name === 'content-enrichment');
    const service = body.workflows.find((w) => w.name === 'summary');
    expect(workflow).toMatchObject({
      kind: 'workflow',
      restateName: 'ContentEnrichment',
      dependencies: [{ kind: 'service', name: 'summary' }],
    });
    expect(workflow?.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'api', type: 'rest', observedStatus: 'active' }),
        expect.objectContaining({
          id: 'content-published',
          type: 'kafka',
          observedStatus: 'active',
          subscriptionId: expect.any(String),
        }),
      ]),
    );
    expect(service).toMatchObject({ kind: 'service', visibility: 'private', triggers: [] });

    const detail = (await api<WorkflowDetail>('GET', '/v1/workflows/content-enrichment')).body;
    expect(detail.schemas.input.required).toEqual(['contentId', 'text']);
    expect(detail.contractHash).toMatch(/^sha256:/);
  });

  it('keeps SummaryService private: direct ingress calls are rejected', () => {
    const out = compose(
      'exec',
      '-T',
      'restate',
      'curl',
      '-s',
      '-X',
      'POST',
      'http://localhost:8080/restate/call/SummaryService/summarize',
      '-H',
      'content-type: application/json',
      '-d',
      '{"text":"x","maxWords":10}',
    );
    expect(out).toContain('not public');
  });
});

describe('REST trigger', () => {
  it('runs the workflow and deduplicates by Idempotency-Key', async () => {
    const key = `e2e-${uniq()}`;
    const input = { contentId: `c-${key}`, title: 'Restate', text: TEXT };
    const first = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/content-enrichment/runs',
      { input },
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('Accepted');
    expect(first.headers.get('location')).toBe(`/v1/runs/content-enrichment/${first.body.runId}`);

    const again = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/content-enrichment/runs',
      { input },
      { 'idempotency-key': key },
    );
    expect(again.body).toMatchObject({ runId: first.body.runId, status: 'PreviouslyAccepted' });

    const run = await waitForRun('content-enrichment', first.body.runId);
    expect(run).toMatchObject({
      status: 'completed',
      workflowVersion: VERSION,
      trigger: { type: 'rest', id: 'api', idempotencyKey: key },
      output: { contentId: input.contentId, metadata: { trigger: 'rest', model: 'chat-default' } },
    });
    expect((run.output as { summary: string }).summary.length).toBeGreaterThan(10);
  });

  it('validates input against the catalogued contract', async () => {
    const res = await api<ErrorEnvelope>('POST', '/v1/workflows/content-enrichment/runs', {
      input: { contentId: 'x' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});

describe('Kafka trigger', () => {
  it('starts one run per record, with the trigger context carried in the run', async () => {
    const id = `do_${uniq()}`;
    const event = { identifier: id, objectType: 'Content', edata: { title: 'Kafka', body: TEXT } };
    publish('content.published', event);
    publish('content.published', event); // a re-publish is a new record → a new run

    // `trigger` and `output` are opaque in the wire contract — this suite knows their real shapes.
    const trigger = (run: RunView) => run.trigger as { type?: string; offset?: number } | undefined;
    const output = (run: RunView) =>
      run.output as { contentId?: string; summary?: string } | undefined;

    let runs: RunView[] = [];
    await expect
      .poll(
        async () => {
          const { body } = await api<RunList>(
            'GET',
            '/v1/runs?workflow=content-enrichment&limit=50',
          );
          const kafkaRuns = body.runs.filter((r) => trigger(r)?.type === 'kafka');
          const ours = await Promise.all(
            kafkaRuns.map((r) => api<RunView>('GET', `/v1/runs/content-enrichment/${r.runId}`)),
          );
          runs = ours
            .map((o) => o.body)
            .filter(
              (r) =>
                output(r)?.contentId === id ||
                (r.status !== 'completed' && trigger(r)?.type === 'kafka'),
            );
          return runs.filter((r) => r.status === 'completed' && output(r)?.contentId === id).length;
        },
        { timeout: 300_000, interval: 2000 },
      )
      .toBe(2);
    const mine = runs.filter((r) => output(r)?.contentId === id);
    expect(new Set(mine.map((r) => r.runId)).size).toBe(2);
    for (const r of mine) {
      expect(r.runId).toMatch(/^kf_[0-9a-f]{32}$/);
      expect(r.trigger).toMatchObject({
        type: 'kafka',
        id: 'content-published',
        source: 'content.published',
      });
      expect(trigger(r)?.offset).toEqual(expect.any(Number));
    }
  });

  it('fails malformed records terminally without blocking the topic', async () => {
    const before = await restateSql<{ n: number }>(
      "SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'ContentEnrichmentTrigger' AND completion_failure LIKE '[400]%'",
    );
    publish('content.published', { identifier: 'broken' });
    await expect
      .poll(
        async () => {
          const [row] = await restateSql<{ n: number }>(
            "SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'ContentEnrichmentTrigger' AND completion_failure LIKE '[400]%'",
          );
          return Number(row?.n);
        },
        { timeout: 60_000, interval: 1000 },
      )
      .toBe(Number(before[0]?.n ?? 0) + 1);
  });
});
