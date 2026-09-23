import type { Generate } from '@ai-pipeline/ai/generate';
import { contentMetadataApi } from '@ai-pipeline/contract-content-metadata/api';
import { quizGenerateApi } from '@ai-pipeline/contract-quiz-generate/api';
import { kafkaRunId } from '@ai-pipeline/metadata/run-ids';
import type { KafkaTriggerResult } from '@ai-pipeline/runtime/kafka-trigger';
import { createContentMetadataService } from '@ai-pipeline/svc-content-metadata/service';
import { CONTENT_METADATA_SYSTEM } from '@ai-pipeline/svc-content-metadata/prompt';
import { createQuizGenerateService } from '@ai-pipeline/svc-quiz-generate/service';
import { QUIZ_SYSTEM } from '@ai-pipeline/svc-quiz-generate/prompt';
import { createSummaryService } from '@ai-pipeline/svc-summary/service';
import { SUMMARY_SYSTEM } from '@ai-pipeline/svc-summary/prompt';
import type * as restate from '@restatedev/restate-sdk';
import * as clients from '@restatedev/restate-sdk-clients';
import { RestateContainer, RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ContentAuthoringOutput, ContentAuthoringRequest } from './schemas.js';
import { contentAuthoringTrigger } from './trigger.js';
import { createContentAuthoring } from './workflow.js';

// By-name clients are typed with the handler map (callers outside Restate need no implementation).
// They must be type aliases, not interfaces: the SDK's by-name client constrains its generic to an
// index-signature type, which an object-literal alias satisfies implicitly and an interface does not.
type ContentAuthoringWf = {
  run: (
    ctx: restate.WorkflowContext,
    request: ContentAuthoringRequest,
  ) => Promise<ContentAuthoringOutput>;
};
type TriggerSvc = {
  onDikshaContentPublished: (
    ctx: restate.Context,
    record: Uint8Array,
  ) => Promise<KafkaTriggerResult>;
};

const QUESTION = {
  question: 'What absorbs light energy in a leaf?',
  options: ['Glucose', 'Chlorophyll', 'Oxygen', 'Water'],
  answerIndex: 1,
};

/**
 * Runs the real handlers against a Restate server with always-replay on, so any non-determinism
 * fails here instead of on a production retry.
 *
 * The point of the test is the pair of counters: the workflow body runs many times, and each
 * journaled step — every model call, and the one `ctx.run` the workflow owns — runs exactly once.
 */
describe('ContentAuthoring (always replay)', () => {
  const generate = vi.fn<Generate>(async ({ system, model }) => {
    if (system === SUMMARY_SYSTEM)
      return { text: 'Plants turn light into food.', model, usage: { outputTokens: 6 } };
    if (system === CONTENT_METADATA_SYSTEM)
      return {
        text: JSON.stringify({
          keywords: ['photosynthesis', 'chlorophyll'],
          concepts: ['energy conversion'],
          difficulty: 'beginner',
        }),
        model,
        usage: { outputTokens: 20 },
      };
    if (system === QUIZ_SYSTEM)
      return { text: JSON.stringify([QUESTION]), model, usage: { outputTokens: 40 } };
    throw new Error(`unexpected system prompt: ${String(system)}`);
  });
  const publish = vi.fn();
  const contentAuthoring = createContentAuthoring(publish);

  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let runExecutions = 0;

  beforeAll(async () => {
    const definitions = [
      contentAuthoring,
      contentAuthoringTrigger,
      createSummaryService(generate),
      createContentMetadataService(generate),
      createQuizGenerateService(generate),
    ];
    // Service-level options override server defaults, so always-replay must be forced per
    // service: suspend at every await (replay), and fail fast on a journal mismatch.
    for (const d of definitions as unknown as { options?: object }[])
      d.options = {
        ...d.options,
        inactivityTimeout: 0,
        retryPolicy: { maxAttempts: 3, onMaxAttempts: 'kill' },
      };
    // Count executions of the workflow body to prove it really replays.
    // (The SDK keeps the function on the HandlerWrapper behind Symbol(Handler).)
    type Fn = (...args: unknown[]) => Promise<unknown>;
    const run = (contentAuthoring as unknown as { workflow: { run: Record<symbol, unknown> } })
      .workflow.run;
    const handlerSymbol = Object.getOwnPropertySymbols(run).find(
      (s) => s.description === 'Handler',
    );
    const wrapper = run[handlerSymbol!] as { handler: Fn };
    const body = wrapper.handler;
    wrapper.handler = (...args) => {
      runExecutions++;
      return body(...args);
    };
    // The test environment serves every definition on one endpoint; ingressPrivate still applies.
    env = await RestateTestEnvironment.start({ services: definitions }, () =>
      new RestateContainer('1.7.10').alwaysReplay(),
    );
    ingress = clients.connect({ url: env.baseUrl() });
  });

  afterAll(async () => env?.stop());

  const request = (contentId: string): ContentAuthoringRequest => ({
    input: {
      contentId,
      name: 'Photosynthesis',
      description: 'How green plants make food',
      text: 'Chlorophyll in the leaves absorbs light energy.',
      subject: 'Science',
      gradeLevel: 'Class 7',
      language: 'en',
    },
    trigger: { type: 'rest', id: 'api', receivedAt: 1_700_000_000_000 },
  });

  it('runs once per run id and returns summary, metadata and quiz', async () => {
    const client = ingress.workflowClient<ContentAuthoringWf>(
      { name: 'ContentAuthoring' },
      'api_run_1',
    );
    const first = await client.workflowSubmit(request('do_1'));
    const again = await client.workflowSubmit(request('do_1'));
    expect(first.status).toBe('Accepted');
    expect(again.status).toBe('PreviouslyAccepted');

    const output = await client.workflowAttach();
    expect(output).toMatchObject({
      contentId: 'do_1',
      name: 'Photosynthesis',
      summary: 'Plants turn light into food.',
      metadata: {
        keywords: ['photosynthesis', 'chlorophyll'],
        concepts: ['energy conversion'],
        difficulty: 'beginner',
        language: 'en',
        subject: 'Science',
        gradeLevel: 'Class 7',
      },
      quiz: { questions: [QUESTION], discarded: 0 },
      provenance: {
        trigger: 'rest',
        models: { summary: 'chat-default', metadata: 'chat-default', quiz: 'chat-default' },
      },
    });
    expect(await env.stateOf(contentAuthoring, 'api_run_1').get('trigger')).toMatchObject({
      type: 'rest',
    });

    // The body replayed (it suspended at every service call), yet each journaled step ran once.
    expect(runExecutions).toBeGreaterThan(1);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ contentId: 'do_1', questions: 1, discarded: 0, keywords: 2 }),
    );
  });

  it('composes the text it sends its callees from the title, blurb and body', () => {
    const prompts = generate.mock.calls.map(([call]) => call.prompt);
    for (const prompt of prompts) {
      expect(prompt).toContain('Photosynthesis');
      expect(prompt).toContain('How green plants make food');
      expect(prompt).toContain('Chlorophyll in the leaves absorbs light energy.');
    }
  });

  it('asks the quiz service to examine the concepts the metadata service found', () => {
    const quizCall = generate.mock.calls.find(([call]) => call.system === QUIZ_SYSTEM);
    expect(quizCall?.[0].prompt).toContain('energy conversion');
  });

  it('keeps the services it calls private to ingress', async () => {
    await expect(
      ingress.client(contentMetadataApi).extract({ text: 'x', maxKeywords: 5 }),
    ).rejects.toThrow();
    await expect(
      ingress.client(quizGenerateApi).generate({ text: 'x', questionCount: 1, focus: [] }),
    ).rejects.toThrow();
  });

  it('maps a DIKSHA record to a workflow run with an opaque run id', async () => {
    const record = new TextEncoder().encode(
      JSON.stringify({
        objectType: 'Content',
        identifier: 'do_9',
        edata: {
          state: 'Live',
          name: 'Water cycle',
          body: 'Water evaporates, condenses and falls again.',
          language: ['Hindi'],
        },
      }),
    );
    const headers = {
      'kafka.partition': '2',
      'kafka.offset': '41',
      'kafka.timestamp': '1700000000123',
    };
    const result = await ingress
      .serviceClient<TriggerSvc>({ name: 'ContentAuthoringTrigger' })
      .onDikshaContentPublished(record, clients.rpc.opts({ input: clients.serde.binary, headers }));
    const runId = kafkaRunId({
      cluster: 'local',
      triggerId: 'diksha-content-published',
      topic: 'diksha.content.published',
      partition: 2,
      offset: 41,
      timestamp: 1700000000123,
    });
    expect(result).toEqual({ runId, invocationId: expect.any(String) });

    const output = await ingress
      .workflowClient<ContentAuthoringWf>({ name: 'ContentAuthoring' }, runId)
      .workflowAttach();
    expect(output.provenance.trigger).toBe('kafka');
    expect(output.metadata.language).toBe('hi');
    expect(await env.stateOf(contentAuthoring, runId).get('trigger')).toMatchObject({
      type: 'kafka',
      id: 'diksha-content-published',
      source: 'diksha.content.published',
      partition: 2,
      offset: 41,
    });
  });

  it('skips a record that is not this workflow’s business without starting a run', async () => {
    const record = new TextEncoder().encode(
      JSON.stringify({ objectType: 'Collection', identifier: 'do_10' }),
    );
    const headers = { 'kafka.partition': '0', 'kafka.offset': '7' };
    await expect(
      ingress
        .serviceClient<TriggerSvc>({ name: 'ContentAuthoringTrigger' })
        .onDikshaContentPublished(
          record,
          clients.rpc.opts({ input: clients.serde.binary, headers }),
        ),
    ).resolves.toEqual({ skipped: true });
  });

  it('fails invalid records terminally, so one bad record cannot wedge the partition', async () => {
    const record = new TextEncoder().encode('{"identifier":"do_11","edata":{}}');
    const headers = { 'kafka.partition': '0', 'kafka.offset': '8' };
    await expect(
      ingress
        .serviceClient<TriggerSvc>({ name: 'ContentAuthoringTrigger' })
        .onDikshaContentPublished(
          record,
          clients.rpc.opts({ input: clients.serde.binary, headers }),
        ),
    ).rejects.toThrow(/adapter rejected/);
  });
});
