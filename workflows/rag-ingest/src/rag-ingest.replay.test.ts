import { memoryRagStore } from '@ai-pipeline/rag/memory';
import { kafkaRunId } from '@ai-pipeline/metadata/run-ids';
import type { KafkaTriggerResult } from '@ai-pipeline/runtime/kafka-trigger';
import type * as restate from '@restatedev/restate-sdk';
import * as clients from '@restatedev/restate-sdk-clients';
import { RestateContainer, RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { RunExtractors } from './extract.js';
import type { RagIngestInput, RagIngestOutput, RagIngestRequest } from './schemas.js';
import { fakeEmbed, UNKNOWN_MODEL } from './testing/fakes.js';
import { ragIngestTrigger } from './trigger.js';
import { createRagIngest } from './workflow.js';

type RagIngestWf = {
  run: (ctx: restate.WorkflowContext, request: RagIngestRequest) => Promise<RagIngestOutput>;
};
type TriggerSvc = {
  onIngest: (ctx: restate.Context, record: Uint8Array) => Promise<KafkaTriggerResult>;
  onDocuments: (ctx: restate.Context, record: Uint8Array) => Promise<KafkaTriggerResult>;
};

/**
 * The real handler against a Restate server with always-replay on. The pairs of counters are the
 * point: the body runs many times, and each journaled step — the collection probe, every document's
 * embedding and write — runs exactly once.
 */
describe('RagIngest (always replay)', () => {
  const store = memoryRagStore();
  const { embed, calls: embedCalls } = fakeEmbed();
  const extractors = vi.fn<RunExtractors>(async (chunks) =>
    chunks.map((chunk) => ({ ...chunk.metadata, excerptKeywords: `keywords of ${chunk.text}` })),
  );
  const ragIngest = createRagIngest({
    store,
    embed,
    languageModels: () => ({}) as never,
    extractors,
  });

  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let runExecutions = 0;

  beforeAll(async () => {
    const definitions = [ragIngest, ragIngestTrigger];
    for (const d of definitions as unknown as { options?: object }[])
      d.options = {
        ...d.options,
        inactivityTimeout: 0,
        retryPolicy: { maxAttempts: 3, onMaxAttempts: 'kill' },
      };
    type Fn = (...args: unknown[]) => Promise<unknown>;
    const run = (ragIngest as unknown as { workflow: { run: Record<symbol, unknown> } }).workflow
      .run;
    const handlerSymbol = Object.getOwnPropertySymbols(run).find(
      (s) => s.description === 'Handler',
    );
    const wrapper = run[handlerSymbol!] as { handler: Fn };
    const body = wrapper.handler;
    wrapper.handler = (...args) => {
      runExecutions++;
      return body(...args);
    };
    env = await RestateTestEnvironment.start({ services: definitions }, () =>
      new RestateContainer('1.7.10').alwaysReplay(),
    );
    ingress = clients.connect({ url: env.baseUrl() });
  }, 180_000);

  afterAll(async () => env?.stop());

  /** What a caller sends: defaults (a document's `format`) may be left out. */
  type Input = z.input<typeof RagIngestInput>;
  const start = (key: string, input: Input, receivedAt = 1_700_000_000_000) =>
    ingress
      .workflowClient<RagIngestWf>({ name: 'RagIngest' }, key)
      .workflowSubmit({
        input,
        trigger: { type: 'rest', id: 'api', receivedAt },
      } as RagIngestRequest)
      .then(() => ingress.workflowClient<RagIngestWf>({ name: 'RagIngest' }, key).workflowAttach());

  it('indexes documents, each in one step, and isolates the one that cannot be indexed', async () => {
    runExecutions = 0;
    const output = await start('api_ingest_1', {
      operation: 'upsert',
      collection: 'replay',
      documents: [
        { id: 'water', format: 'markdown', title: 'Water', text: '# Water\nRain falls on hills.' },
        {
          id: 'fire',
          format: 'text',
          text: 'Fire needs oxygen to burn.',
          metadata: { lang: 'en' },
        },
        { id: 'blank', text: '   ' },
      ],
    });
    expect(output).toMatchObject({
      operation: 'upsert',
      collection: {
        name: 'replay',
        created: true,
        embeddingModel: 'embed-qwen3-0p6b',
        dimension: 8,
      },
      documents: [
        { documentId: 'water', status: 'written', chunks: 1 },
        { documentId: 'fire', status: 'written', chunks: 1 },
        { documentId: 'blank', status: 'failed', error: expect.stringMatching(/no text to index/) },
      ],
      totals: { written: 2, failed: 1, chunks: 2 },
      provenance: { trigger: 'rest' },
    });
    // The body replayed, yet the probe and each document's embedding ran exactly once.
    expect(runExecutions).toBeGreaterThan(1);
    expect(embedCalls.map((c) => c.values.length)).toEqual([1, 1, 1]);
    expect(store.calls.writeDocument).toBe(2);

    const ref = (await store.getCollection('replay'))!;
    const hits = await store.search(
      ref,
      (await embed({ model: 'm', values: ['oxygen burn'] })).embeddings[0]!,
      {
        topK: 1,
      },
    );
    expect(hits[0]?.metadata).toMatchObject({ documentId: 'fire', lang: 'en' });
  });

  it('settles unchanged documents without embedding them, and lets the newest version win', async () => {
    const before = embedCalls.length;
    const unchanged = await start('api_ingest_2', {
      operation: 'upsert',
      collection: 'replay',
      documents: [
        {
          id: 'fire',
          format: 'text',
          text: 'Fire needs oxygen to burn.',
          metadata: { lang: 'en' },
        },
      ],
    });
    expect(unchanged.documents).toEqual([{ documentId: 'fire', status: 'unchanged' }]);
    expect(embedCalls.length).toBe(before);

    await start('api_ingest_3', {
      operation: 'upsert',
      collection: 'replay',
      documents: [{ id: 'v', text: 'Version two.', version: 2 }],
    });
    const older = await start('api_ingest_4', {
      operation: 'upsert',
      collection: 'replay',
      documents: [{ id: 'v', text: 'Version one.', version: 1 }],
    });
    expect(older.documents).toEqual([{ documentId: 'v', status: 'superseded' }]);
    const ref = (await store.getCollection('replay'))!;
    expect((await store.documentChunks(ref, 'v')).map((c) => c.text)).toEqual(['Version two.']);
  });

  it('lets a versioned producer delete a document and add it back later', async () => {
    await start('api_versioned_1', {
      operation: 'upsert',
      collection: 'replay',
      documents: [{ id: 'cyclic', text: 'First life.', version: 1 }],
    });
    const deleted = await start('api_versioned_2', {
      operation: 'delete',
      collection: 'replay',
      documentIds: ['cyclic'],
      version: 2,
    });
    expect(deleted.documents).toEqual([{ documentId: 'cyclic', status: 'deleted' }]);
    const back = await start('api_versioned_3', {
      operation: 'upsert',
      collection: 'replay',
      documents: [{ id: 'cyclic', text: 'Second life.', version: 3 }],
    });
    expect(back.documents).toEqual([{ documentId: 'cyclic', status: 'written', chunks: 1 }]);
  });

  it('refuses a run whose input breaks a rule its schema cannot state', async () => {
    await expect(
      start('api_ingest_bad', {
        operation: 'upsert',
        collection: 'replay',
        documents: [
          { id: 'a', text: 'x' },
          { id: 'a', text: 'y' },
        ],
      }),
    ).rejects.toThrow(/appears twice/);
  });

  it('fails, rather than pauses, a run whose embedding model the gateway does not know', async () => {
    const before = embedCalls.filter((c) => c.model === UNKNOWN_MODEL).length;
    await expect(
      start('api_ingest_unknown_model', {
        operation: 'upsert',
        collection: 'unknown-model',
        collectionSettings: { embedding: { model: UNKNOWN_MODEL } },
        documents: [{ id: 'a', text: 'x' }],
      }),
    ).rejects.toThrow(/probing embed-unknown for its dimension failed: no such model/);
    // Refused once, not retried: `retry.llm` would otherwise keep trying until the run paused.
    expect(embedCalls.filter((c) => c.model === UNKNOWN_MODEL).length - before).toBe(1);
    expect(await store.getCollection('unknown-model')).toBeUndefined();
  });

  it('extracts metadata in batches when asked, and stores it on the chunks', async () => {
    extractors.mockClear();
    await start('api_ingest_extract', {
      operation: 'upsert',
      collection: 'extracted',
      documents: [{ id: 'leaf', text: 'Leaves make food.' }],
      options: { extract: { keywords: true, batchSize: 2 } },
    });
    expect(extractors).toHaveBeenCalledTimes(1);
    const ref = (await store.getCollection('extracted'))!;
    const [chunk] = await store.documentChunks(ref, 'leaf');
    expect(chunk?.metadata.excerptKeywords).toBe('keywords of Leaves make food.');
  });

  it('deletes documents, and drops the collection', async () => {
    const deleted = await start('api_ingest_delete', {
      operation: 'delete',
      collection: 'replay',
      documentIds: ['water', 'never-there'],
    });
    expect(deleted.documents).toEqual([
      { documentId: 'water', status: 'deleted' },
      { documentId: 'never-there', status: 'absent' },
    ]);
    const nowhere = await start('api_ingest_delete_2', {
      operation: 'delete',
      collection: 'no-such-collection',
      documentIds: ['x'],
    });
    expect(nowhere.documents).toEqual([{ documentId: 'x', status: 'absent' }]);

    const dropped = await start('api_ingest_drop', { operation: 'drop', collection: 'extracted' });
    expect(dropped.collection).toEqual({ name: 'extracted', created: false, dropped: true });
    await expect(store.getCollection('extracted')).resolves.toBeUndefined();
  });

  describe('Kafka', () => {
    const deliver = (handler: keyof TriggerSvc, offset: number, event: unknown) =>
      ingress.serviceClient<TriggerSvc>({ name: 'RagIngestTrigger' })[handler](
        new TextEncoder().encode(JSON.stringify(event)),
        clients.rpc.opts({
          input: clients.serde.binary,
          headers: {
            'kafka.partition': '0',
            'kafka.offset': String(offset),
            'kafka.timestamp': '1700000000500',
          },
        }),
      );

    it('maps a producer’s event through the configured mapping and indexes it', async () => {
      const result = await deliver('onDocuments', 1, {
        type: 'document',
        id: 'kafka-doc',
        title: 'Clouds',
        body: 'Clouds are water droplets.',
        lang: 'en',
        tags: ['weather'],
      });
      const runId = kafkaRunId({
        cluster: 'local',
        triggerId: 'documents',
        topic: 'rag.documents',
        partition: 0,
        offset: 1,
        timestamp: 1700000000500,
      });
      expect(result).toEqual({ runId, invocationId: expect.any(String) });
      const output = await ingress
        .workflowClient<RagIngestWf>({ name: 'RagIngest' }, runId)
        .workflowAttach();
      expect(output).toMatchObject({
        collection: { name: 'documents' },
        documents: [{ documentId: 'kafka-doc', status: 'written' }],
        provenance: { trigger: 'kafka' },
      });
      const ref = (await store.getCollection('documents'))!;
      expect((await store.documentChunks(ref, 'kafka-doc'))[0]?.metadata).toMatchObject({
        lang: 'en',
        tags: ['weather'],
        format: 'markdown',
      });
    });

    it('skips what is not its business and fails what is broken, without wedging the topic', async () => {
      await expect(deliver('onDocuments', 2, { type: 'ping' })).resolves.toEqual({ skipped: true });
      await expect(deliver('onDocuments', 3, { type: 'document', id: 'no-text' })).rejects.toThrow(
        /adapter rejected/,
      );
    });

    it('takes canonical input on a trigger without an adapter', async () => {
      const result = await deliver('onIngest', 4, {
        operation: 'upsert',
        collection: 'canonical',
        documents: [{ id: 'c1', text: 'Canonical event.' }],
      });
      expect(result).toMatchObject({ runId: expect.stringMatching(/^kf_/) });
      const output = await ingress
        .workflowClient<RagIngestWf>({ name: 'RagIngest' }, (result as { runId: string }).runId)
        .workflowAttach();
      expect(output.documents).toEqual([{ documentId: 'c1', status: 'written', chunks: 1 }]);
    });
  });
});
