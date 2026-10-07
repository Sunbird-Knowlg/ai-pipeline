import type { TriggerContext } from '@ai-pipeline/contracts/trigger';
import type { CollectionRef } from '@ai-pipeline/rag/store';
import { memoryRagStore } from '@ai-pipeline/rag/memory';
import * as restate from '@restatedev/restate-sdk';
import { describe, expect, it } from 'vitest';
import { ingestDocument } from './ingest.js';
import { planIngest, type UpsertPlan } from './plan.js';
import { RagIngestInput } from './schemas.js';
import { DIMENSION, fakeEmbed, noLanguageModels } from './testing/fakes.js';
import { config } from './unit.js';

const trigger: TriggerContext = { type: 'rest', id: 'api', receivedAt: 1000 };

async function setup(documents: unknown[], options?: unknown) {
  const store = memoryRagStore();
  const { embed, calls } = fakeEmbed();
  const plan = planIngest(
    RagIngestInput.parse({ operation: 'upsert', collection: 'docs', documents, options }),
    config,
    trigger,
    'run-1',
  ) as UpsertPlan;
  const ref: CollectionRef = await store.ensureCollection({
    name: 'docs',
    settings: plan.settings,
    explicit: false,
    incarnation: '7f3e2a1b-0000-4000-8000-000000000000',
    probeDimension: async () => DIMENSION,
  });
  const deps = { store, embed, languageModels: noLanguageModels };
  return { store, calls, plan, ref, deps };
}

const LIMITS = { maxChunksPerDocument: 10, maxExtractChunks: 5 };

describe('ingestDocument', () => {
  it('chunks, embeds the document template, and writes every chunk with its metadata', async () => {
    const { store, calls, plan, ref, deps } = await setup([
      { id: 'a', title: 'Water', text: 'Rain falls. Rivers flow.', metadata: { lang: 'en' } },
    ]);
    const result = await ingestDocument(deps, ref, plan.documents[0]!, plan, LIMITS);
    expect(result).toEqual({ documentId: 'a', status: 'written', chunks: 1 });
    // The default template puts the title before the chunk text.
    expect(calls[0]?.values).toEqual(['Water\n\nRain falls. Rivers flow.']);
    const [chunk] = await store.documentChunks(ref, 'a');
    expect(chunk?.metadata).toMatchObject({
      lang: 'en',
      documentId: 'a',
      chunkIndex: 0,
      chunkCount: 1,
      text: 'Rain falls. Rivers flow.',
      title: 'Water',
      format: 'text',
      seq: 1000,
    });
  });

  it('settles an unchanged document without embedding it again', async () => {
    const { calls, plan, ref, deps } = await setup([{ id: 'a', text: 'Same text.' }]);
    await ingestDocument(deps, ref, plan.documents[0]!, plan, LIMITS);
    const again = { ...plan.documents[0]!, order: { seq: 2000, runId: 'run-2' } };
    await expect(ingestDocument(deps, ref, again, plan, LIMITS)).resolves.toEqual({
      documentId: 'a',
      status: 'unchanged',
    });
    expect(calls).toHaveLength(1);
    // force re-embeds it anyway.
    const forced = { ...plan.documents[0]!, order: { seq: 3000, runId: 'run-3' } };
    await expect(
      ingestDocument(deps, ref, forced, { ...plan, force: true }, LIMITS),
    ).resolves.toMatchObject({ status: 'written' });
    expect(calls).toHaveLength(2);
  });

  it('reports a retry of its own write as written, not unchanged', async () => {
    const { plan, ref, deps } = await setup([{ id: 'a', text: 'Once.' }]);
    await ingestDocument(deps, ref, plan.documents[0]!, plan, LIMITS);
    await expect(ingestDocument(deps, ref, plan.documents[0]!, plan, LIMITS)).resolves.toEqual({
      documentId: 'a',
      status: 'written',
    });
  });

  it('fails a document for good when it cannot be indexed', async () => {
    const { plan, ref, deps } = await setup([{ id: 'big', text: 'word '.repeat(2000) }], {
      chunking: { strategy: 'recursive', maxSize: 100, overlap: 0 },
    });
    const error = await ingestDocument(deps, ref, plan.documents[0]!, plan, LIMITS).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(restate.TerminalError);
    expect((error as Error).message).toMatch(/chunks; the limit is 10/);
  });

  it('refuses vectors of another size than the collection was created with', async () => {
    const { plan, ref, deps } = await setup([{ id: 'a', text: 'Text.' }]);
    const wrong = fakeEmbed(DIMENSION + 1).embed;
    const error = await ingestDocument(
      { ...deps, embed: wrong },
      ref,
      plan.documents[0]!,
      plan,
      LIMITS,
    ).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/remapped/);
  });
});
