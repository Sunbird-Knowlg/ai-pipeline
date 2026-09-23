import type { Generate } from '@ai-pipeline/ai/generate';
import {
  type ContentEnrichmentRequest,
  type ContentOutput,
} from '@ai-pipeline/contracts/content-enrichment';
import { summaryApi } from '@ai-pipeline/contracts/summary/api';
import { kafkaRunId } from '@ai-pipeline/metadata/run-ids';
import type { KafkaTriggerResult } from '@ai-pipeline/runtime/kafka-trigger';
import { createSummaryService } from '@ai-pipeline/svc-summary/service';
import type * as restate from '@restatedev/restate-sdk';
import * as clients from '@restatedev/restate-sdk-clients';
import { RestateContainer, RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentEnrichmentTrigger } from './trigger.js';
import { contentEnrichment } from './workflow.js';

// By-name clients are typed with the handler map (callers outside Restate need no implementation).
// They must be type aliases, not interfaces: the SDK's by-name client constrains its generic to an
// index-signature type, which an object-literal alias satisfies implicitly and an interface does not.
type ContentEnrichmentWf = {
  run: (ctx: restate.WorkflowContext, request: ContentEnrichmentRequest) => Promise<ContentOutput>;
};
type TriggerSvc = {
  onContentPublished: (ctx: restate.Context, record: Uint8Array) => Promise<KafkaTriggerResult>;
};

/**
 * Runs the real handlers against a Restate server with always-replay on, so any
 * non-determinism fails here instead of on a production retry.
 */
describe('ContentEnrichment (always replay)', () => {
  const generate = vi.fn<Generate>(async ({ model }: { model: string }) => ({
    text: 'A short summary.',
    model,
    usage: { inputTokens: 10, outputTokens: 4 },
  }));
  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let runExecutions = 0;

  beforeAll(async () => {
    const summary = createSummaryService(generate);
    const definitions = [contentEnrichment, contentEnrichmentTrigger, summary];
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
    const run = (contentEnrichment as unknown as { workflow: { run: Record<symbol, unknown> } })
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

  const request = (contentId: string): ContentEnrichmentRequest => ({
    input: { contentId, title: 'Title', text: 'one two three four' },
    trigger: { type: 'rest', id: 'api', receivedAt: 1_700_000_000_000 },
  });

  it('runs once per run id and returns summary + metadata', async () => {
    const client = ingress.workflowClient<ContentEnrichmentWf>(
      { name: 'ContentEnrichment' },
      'api_run_1',
    );
    const first = await client.workflowSubmit(request('c-1'));
    const again = await client.workflowSubmit(request('c-1'));
    expect(first.status).toBe('Accepted');
    expect(again.status).toBe('PreviouslyAccepted');

    const output = await client.workflowAttach();
    expect(output).toMatchObject({
      contentId: 'c-1',
      summary: 'A short summary.',
      metadata: { wordCount: 4, charCount: 18, model: 'chat-default', trigger: 'rest' },
    });
    expect(await env.stateOf(contentEnrichment, 'api_run_1').get('trigger')).toMatchObject({
      type: 'rest',
    });
    // The body replayed (it suspended at the service call), yet the LLM side effect ran once.
    expect(runExecutions).toBeGreaterThan(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps SummaryService private to ingress', async () => {
    await expect(
      ingress.client(summaryApi).summarize({ text: 'x', maxWords: 10 }),
    ).rejects.toThrow();
  });

  it('maps a Kafka record to a workflow run with an opaque run id', async () => {
    const record = new TextEncoder().encode(
      JSON.stringify({
        identifier: 'do_9',
        objectType: 'Content',
        edata: { body: 'hello kafka world' },
      }),
    );
    const headers = {
      'kafka.partition': '2',
      'kafka.offset': '41',
      'kafka.timestamp': '1700000000123',
    };
    const result = await ingress
      .serviceClient<TriggerSvc>({ name: 'ContentEnrichmentTrigger' })
      .onContentPublished(record, clients.rpc.opts({ input: clients.serde.binary, headers }));
    const runId = kafkaRunId({
      cluster: 'local',
      triggerId: 'content-published',
      topic: 'content.published',
      partition: 2,
      offset: 41,
      timestamp: 1700000000123,
    });
    expect(result).toEqual({ runId, invocationId: expect.any(String) });

    const output = await ingress
      .workflowClient<ContentEnrichmentWf>({ name: 'ContentEnrichment' }, runId)
      .workflowAttach();
    expect(output.metadata.trigger).toBe('kafka');
    expect(await env.stateOf(contentEnrichment, runId).get('trigger')).toMatchObject({
      type: 'kafka',
      id: 'content-published',
      source: 'content.published',
      partition: 2,
      offset: 41,
    });
  });

  it('fails invalid Kafka records terminally', async () => {
    const record = new TextEncoder().encode('{"identifier":"x"}');
    const headers = { 'kafka.partition': '0', 'kafka.offset': '1' };
    await expect(
      ingress
        .serviceClient<TriggerSvc>({ name: 'ContentEnrichmentTrigger' })
        .onContentPublished(record, clients.rpc.opts({ input: clients.serde.binary, headers })),
    ).rejects.toThrow(/adapter rejected/);
  });
});
