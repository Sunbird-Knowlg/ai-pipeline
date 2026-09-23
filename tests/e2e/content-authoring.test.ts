import { readFileSync } from 'node:fs';
import type { ErrorEnvelope } from '@ai-pipeline/api-contract/errors';
import type { RunList, RunView } from '@ai-pipeline/api-contract/runs';
import type {
  StartRunAccepted,
  WorkflowDetail,
  WorkflowList,
} from '@ai-pipeline/api-contract/workflows';
import { describe, expect, it } from 'vitest';
import { api, publish, restateSql, uniq, waitForRun } from './support.js';

/**
 * The reference workflow, end to end against the running stack and the real model.
 *
 * `content-authoring` is the example a new workflow is written from: two triggers, three shared
 * services (two of them called in parallel), and one side effect of its own. This suite is what
 * says the whole path works — catalogue, both triggers, the calls between units, and the output the
 * runs API serves back.
 */
const VERSION = JSON.parse(
  readFileSync('workflows/content-authoring/metadata.json', 'utf8'),
).version;

const TEXT =
  'Photosynthesis is the process by which green plants make their own food. Chlorophyll in the ' +
  'leaves absorbs light energy from the sun. The plant takes in carbon dioxide through tiny pores ' +
  'called stomata, and water through its roots. Using the light energy, it converts these into ' +
  'glucose and releases oxygen as a by-product. The process takes place mainly in the chloroplasts ' +
  'of the leaf cells.';

/** `output` is opaque in the wire contract — this suite knows the shape the workflow returns. */
interface Pack {
  contentId: string;
  name: string;
  summary: string;
  metadata: {
    keywords: string[];
    concepts: string[];
    difficulty: string;
    language: string;
    subject?: string;
    gradeLevel?: string;
    wordCount: number;
    readingTimeMinutes: number;
  };
  quiz: {
    questions: { question: string; options: string[]; answerIndex: number }[];
    discarded: number;
  };
  provenance: {
    trigger: string;
    version: string;
    models: { summary: string; metadata: string; quiz: string };
    authoredAt: number;
  };
}

const pack = (run: RunView) => run.output as Pack;

describe('content-authoring catalogue', () => {
  it('lists the workflow with both triggers and all three private dependencies', async () => {
    const { body } = await api<WorkflowList>('GET', '/v1/workflows');
    const workflow = body.workflows.find((w) => w.name === 'content-authoring');
    expect(workflow).toMatchObject({
      kind: 'workflow',
      restateName: 'ContentAuthoring',
      dependencies: expect.arrayContaining([
        { kind: 'service', name: 'summary' },
        { kind: 'service', name: 'content-metadata' },
        { kind: 'service', name: 'quiz-generate' },
      ]),
    });
    expect(workflow?.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'api', type: 'rest', observedStatus: 'active' }),
        expect.objectContaining({
          id: 'diksha-content-published',
          type: 'kafka',
          observedStatus: 'active',
          subscriptionId: expect.any(String),
        }),
      ]),
    );

    for (const name of ['content-metadata', 'quiz-generate'])
      expect(body.workflows.find((w) => w.name === name)).toMatchObject({
        kind: 'service',
        visibility: 'private',
        triggers: [],
      });
  });

  it('publishes an input schema in which only the defaulted fields are optional', async () => {
    const detail = (await api<WorkflowDetail>('GET', '/v1/workflows/content-authoring')).body;
    // `language` has a default, so the *input* schema marks it optional and the handler fills it in.
    expect(detail.schemas.input.required).toEqual(['contentId', 'name', 'text']);
    expect(detail.contractHash).toMatch(/^sha256:/);
  });
});

describe('content-authoring REST trigger', () => {
  it('builds an authoring pack from a DIKSHA payload', async () => {
    const key = `e2e-${uniq()}`;
    const input = {
      contentId: `do_${key}`,
      name: 'Photosynthesis',
      description: 'How green plants make their own food',
      text: TEXT,
      subject: 'Science',
      gradeLevel: 'Class 7',
    };
    const started = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/content-authoring/runs',
      { input },
      { 'idempotency-key': key },
    );
    expect(started.status).toBe(202);
    expect(started.body.status).toBe('Accepted');

    const run = await waitForRun('content-authoring', started.body.runId);
    expect(run).toMatchObject({
      status: 'completed',
      workflowVersion: VERSION,
      trigger: { type: 'rest', id: 'api', idempotencyKey: key },
    });

    const output = pack(run);
    expect(output.contentId).toBe(input.contentId);
    expect(output.summary.length).toBeGreaterThan(20);

    // Metadata: the model's part, plus the deterministic part the workflow computes itself.
    expect(output.metadata.keywords.length).toBeGreaterThan(0);
    expect(output.metadata.keywords.length).toBeLessThanOrEqual(8); // config.maxKeywords
    expect(['beginner', 'intermediate', 'advanced']).toContain(output.metadata.difficulty);
    expect(output.metadata.subject).toBe('Science');
    expect(output.metadata.gradeLevel).toBe('Class 7');
    expect(output.metadata.language).toBe('en'); // defaulted: the request omitted it
    expect(output.metadata.wordCount).toBeGreaterThan(50);

    // Quiz: every question well formed, and no more than the configured number of them.
    expect(output.quiz.questions.length).toBeGreaterThan(0);
    expect(output.quiz.questions.length).toBeLessThanOrEqual(3); // config.questionCount
    for (const q of output.quiz.questions) {
      expect(q.options).toHaveLength(4);
      expect(q.answerIndex).toBeGreaterThanOrEqual(0);
      expect(q.answerIndex).toBeLessThan(4);
      expect(q.options[q.answerIndex]).toBeTruthy();
    }

    // Provenance: which model answered for each capability, so a bad pack can be traced.
    expect(output.provenance).toMatchObject({
      trigger: 'rest',
      version: VERSION,
      models: { summary: 'chat-default', metadata: 'chat-default', quiz: 'chat-default' },
    });
    expect(run.traceId).toEqual(expect.any(String));
  });

  it('deduplicates by Idempotency-Key', async () => {
    const key = `e2e-dedupe-${uniq()}`;
    const input = { contentId: `do_${key}`, name: 'N', text: TEXT };
    const first = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/content-authoring/runs',
      { input },
      { 'idempotency-key': key },
    );
    const again = await api<StartRunAccepted>(
      'POST',
      '/v1/workflows/content-authoring/runs',
      { input },
      { 'idempotency-key': key },
    );
    expect(again.body).toMatchObject({ runId: first.body.runId, status: 'PreviouslyAccepted' });
  });

  it('validates input against the catalogued contract', async () => {
    const missing = await api<ErrorEnvelope>('POST', '/v1/workflows/content-authoring/runs', {
      input: { contentId: 'do_1' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('INVALID_INPUT');

    const unknownKey = await api<ErrorEnvelope>('POST', '/v1/workflows/content-authoring/runs', {
      input: { contentId: 'do_1', name: 'N', text: 't', mimeType: 'video/mp4' },
    });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error.code).toBe('INVALID_INPUT');
  });
});

describe('content-authoring Kafka trigger', () => {
  const trigger = (run: RunView) => run.trigger as { type?: string; id?: string } | undefined;

  it('starts a run from a published DIKSHA content event', async () => {
    const id = `do_${uniq()}`;
    publish('diksha.content.published', {
      eid: 'BE_OBJECT_LIFECYCLE',
      objectType: 'Content',
      identifier: id,
      edata: {
        state: 'Live',
        name: 'Photosynthesis',
        description: 'How green plants make their own food',
        body: TEXT,
        subject: ['Science'],
        gradeLevel: ['Class 7'],
        language: ['English'],
      },
    });

    let found: RunView | undefined;
    await expect
      .poll(
        async () => {
          const { body } = await api<RunList>(
            'GET',
            '/v1/runs?workflow=content-authoring&limit=50',
          );
          const kafkaRuns = body.runs.filter((r) => trigger(r)?.type === 'kafka');
          const full = await Promise.all(
            kafkaRuns.map((r) => api<RunView>('GET', `/v1/runs/content-authoring/${r.runId}`)),
          );
          found = full
            .map((o) => o.body)
            .find((r) => r.status === 'completed' && pack(r)?.contentId === id);
          return found !== undefined;
        },
        { timeout: 420_000, interval: 2000 },
      )
      .toBe(true);

    expect(found!.runId).toMatch(/^kf_[0-9a-f]{32}$/);
    expect(found!.trigger).toMatchObject({
      type: 'kafka',
      id: 'diksha-content-published',
      source: 'diksha.content.published',
    });
    const output = pack(found!);
    expect(output.provenance.trigger).toBe('kafka');
    // The adapter translates the platform's vocabulary: ["English"] becomes the code `en`.
    expect(output.metadata.language).toBe('en');
    expect(output.metadata.subject).toBe('Science');
    expect(output.quiz.questions.length).toBeGreaterThan(0);
  });

  it('skips objects that are not published Content, without starting a run', async () => {
    // Counted in Restate rather than through the paginated runs API: a page size would silently
    // cap the "before" count once the retention window holds more runs than the page.
    const invocations = async (service: string) => {
      const [row] = await restateSql<{ n: number }>(
        `SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = '${service}'`,
      );
      return Number(row?.n ?? 0);
    };
    const runsBefore = await invocations('ContentAuthoring');
    const triggersBefore = await invocations('ContentAuthoringTrigger');

    publish('diksha.content.published', {
      objectType: 'Collection',
      identifier: `do_${uniq()}`,
      edata: { state: 'Live', name: 'A textbook', body: TEXT },
    });
    publish('diksha.content.published', {
      objectType: 'Content',
      identifier: `do_${uniq()}`,
      edata: { state: 'Draft', name: 'Not ready', body: TEXT },
    });

    // Wait for the evidence that both records were *consumed* rather than for a fixed interval,
    // then assert that consuming them started nothing.
    await expect
      .poll(() => invocations('ContentAuthoringTrigger'), { timeout: 120_000, interval: 1000 })
      .toBe(triggersBefore + 2);
    expect(await invocations('ContentAuthoring')).toBe(runsBefore);
  });

  it('fails malformed records terminally without blocking the topic', async () => {
    const count = async () => {
      const [row] = await restateSql<{ n: number }>(
        "SELECT count(*) AS n FROM sys_invocation WHERE target_service_name = 'ContentAuthoringTrigger' AND completion_failure LIKE '[400]%'",
      );
      return Number(row?.n ?? 0);
    };
    const before = await count();
    // Live Content with nothing to work on: the adapter throws, and the record fails terminally.
    publish('diksha.content.published', {
      objectType: 'Content',
      identifier: `do_${uniq()}`,
      edata: { state: 'Live', name: 'Empty' },
    });
    await expect.poll(count, { timeout: 60_000, interval: 1000 }).toBe(before + 1);
  });
});
