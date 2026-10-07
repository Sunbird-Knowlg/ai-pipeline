import type { ErrorEnvelope } from '@ai-pipeline/api-contract/errors';
import type { RunView } from '@ai-pipeline/api-contract/runs';
import type { StartRunAccepted, WorkflowList } from '@ai-pipeline/api-contract/workflows';
import { describe, expect, it, vi } from 'vitest';
import { api, publish, uniq, waitForRun } from './support.js';

/**
 * RAG on the real stack and the real models: `rag-ingest` indexes into a fresh collection,
 * `rag-query` answers core-api's `/v1/rag` routes.
 *
 * Preconditions beyond the other suites: host Ollama serves `qwen3-embedding:0.6b`, and the
 * Postgres volume was provisioned with `infra/postgres/init/30-rag.sql`.
 *
 * The RAG routes pass the service's JSON through untouched (core-api imports no unit contract), so
 * the shapes this suite reads are declared here, from docs/rag.md.
 */

interface IngestOutput {
  operation: 'upsert' | 'delete' | 'drop';
  collection: {
    name: string;
    created: boolean;
    dropped?: boolean;
    embeddingModel?: string;
    dimension?: number;
  };
  documents: { documentId: string; status: string; chunks?: number; error?: string }[];
  totals: Record<string, number>;
}
interface Collection {
  name: string;
  embeddingModel: string;
  dimension: number;
  documents: number;
  chunks: number;
}
interface Hit {
  id: string;
  score: number;
  documentId: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
}
interface SearchResponse {
  collection: string;
  hits: Hit[];
  reranked: boolean;
}
interface AnswerResponse {
  status: 'answered' | 'insufficient_evidence';
  answer: string;
  citations: { id: string; documentId: string; chunkIndex: number }[];
  model: string;
}
interface DocumentView {
  documentId: string;
  chunkCount: number;
  chunks?: { chunkIndex: number; text: string }[];
}

const COLLECTION = `e2e-${uniq()}`;
const base = `/v1/rag/collections/${COLLECTION}`;

const DOCUMENTS = [
  {
    id: 'water-cycle',
    title: 'The water cycle',
    format: 'markdown',
    text: '# The water cycle\nHeat from the sun evaporates water from oceans and lakes. The vapour rises, cools and condenses into clouds. When the droplets grow heavy they fall back as rain.',
    metadata: { subject: 'Science', grade: 7 },
  },
  {
    id: 'photosynthesis',
    title: 'Photosynthesis',
    text: 'Green plants make their own food. Chlorophyll in the leaves absorbs sunlight, and the plant turns water and carbon dioxide into glucose and oxygen.',
    metadata: { subject: 'Science', grade: 7 },
  },
  {
    id: 'fractions',
    title: 'Adding fractions',
    text: 'To add fractions with different denominators, first rewrite them over a common denominator, then add the numerators.',
    metadata: { subject: 'Math', grade: 6 },
  },
];

async function ingest(
  path: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
): Promise<IngestOutput> {
  const started = await api<StartRunAccepted>(method, path, body);
  expect(started.status).toBe(202);
  expect(started.headers.get('location')).toBe(`/v1/runs/rag-ingest/${started.body.runId}`);
  const run = await waitForRun('rag-ingest', started.body.runId);
  expect(run.status, JSON.stringify(run)).toBe('completed');
  return run.output as IngestOutput;
}

describe('RAG', () => {
  it('catalogues both units: the query service public, the workflow with three triggers', async () => {
    const { body } = await api<WorkflowList>('GET', '/v1/workflows');
    expect(body.workflows.find((w) => w.name === 'rag-query')).toMatchObject({
      kind: 'service',
      visibility: 'public',
    });
    const ingest = body.workflows.find((w) => w.name === 'rag-ingest');
    expect(ingest?.triggers.map((t) => [t.id, t.observedStatus])).toEqual(
      expect.arrayContaining([
        ['api', 'active'],
        ['ingest', 'active'],
        ['documents', 'active'],
      ]),
    );
  });

  it('indexes documents over REST, creating the collection', async () => {
    const output = await ingest(`${base}/documents`, 'POST', { documents: DOCUMENTS });
    expect(output.collection).toMatchObject({
      name: COLLECTION,
      created: true,
      embeddingModel: 'embed-qwen3-0p6b',
      dimension: 1024,
    });
    expect(output.documents.map((d) => d.status)).toEqual(['written', 'written', 'written']);
  });

  it('describes the collection, lists its documents, and returns one with its chunks', async () => {
    const collection = (await api<Collection>('GET', base)).body;
    expect(collection).toMatchObject({ name: COLLECTION, documents: 3, dimension: 1024 });
    expect(collection.chunks).toBeGreaterThanOrEqual(3);

    const listed = (await api<{ documents: DocumentView[] }>('GET', `${base}/documents?limit=2`))
      .body;
    expect(listed.documents).toHaveLength(2);

    const document = (await api<DocumentView>('GET', `${base}/documents/water-cycle?chunks=true`))
      .body;
    expect(document.chunks?.map((c) => c.text).join(' ')).toContain('condenses into clouds');
  });

  it('finds the relevant document, and narrows by metadata', async () => {
    const search = (body: unknown) => api<SearchResponse>('POST', `${base}/search`, body);
    const rain = await search({ query: 'Why does it rain?', topK: 3 });
    expect(rain.status).toBe(200);
    expect(rain.body.hits[0]?.documentId).toBe('water-cycle');

    const math = await search({ query: 'Why does it rain?', topK: 3, filter: { subject: 'Math' } });
    expect(math.body.hits.map((h) => h.documentId)).toEqual(['fractions']);
  });

  it('answers from the collection, citing only what it retrieved', async () => {
    const { status, body } = await api<AnswerResponse>('POST', `${base}/answer`, {
      question: 'What do green plants need to make their food?',
    });
    expect(status).toBe(200);
    expect(['answered', 'insufficient_evidence']).toContain(body.status);
    if (body.status === 'answered') {
      expect(body.citations.length).toBeGreaterThan(0);
      for (const citation of body.citations)
        expect(DOCUMENTS.map((d) => d.id)).toContain(citation.documentId);
    }
  }, 300_000);

  it('settles an unchanged re-send, and keeps the newest version whatever lands last', async () => {
    const again = await ingest(`${base}/documents`, 'POST', { documents: DOCUMENTS.slice(0, 1) });
    expect(again.documents).toEqual([{ documentId: 'water-cycle', status: 'unchanged' }]);

    const versioned = (version: number, text: string) => ({
      documents: [{ id: 'versioned', text, version }],
    });
    await ingest(`${base}/documents`, 'POST', versioned(2, 'The second version.'));
    const older = await ingest(`${base}/documents`, 'POST', versioned(1, 'The first version.'));
    expect(older.documents).toEqual([{ documentId: 'versioned', status: 'superseded' }]);
    const document = (await api<DocumentView>('GET', `${base}/documents/versioned?chunks=true`))
      .body;
    expect(document.chunks?.map((c) => c.text)).toEqual(['The second version.']);

    // A versioned delete is ordered among the versions, so a later version can bring it back.
    const deleted = await ingest(`${base}/documents/versioned?version=3`, 'DELETE');
    expect(deleted.documents).toEqual([{ documentId: 'versioned', status: 'deleted' }]);
    const back = await ingest(`${base}/documents`, 'POST', versioned(4, 'The fourth version.'));
    expect(back.documents).toEqual([{ documentId: 'versioned', status: 'written', chunks: 1 }]);
  });

  it('indexes fake Kafka events: canonical input, and a producer shape mapped by configuration', async () => {
    const id = `kafka-${uniq()}`;
    publish('rag.ingest', {
      operation: 'upsert',
      collection: COLLECTION,
      documents: [{ id, text: 'Canonical events go straight to the workflow.' }],
    });
    await vi.waitFor(
      async () => expect((await api('GET', `${base}/documents/${id}`)).status).toBe(200),
      { timeout: 120_000, interval: 1000 },
    );

    // `eventMappings.documentEvent` sends these to the `documents` collection.
    const mapped = `mapped-${uniq()}`;
    publish('rag.documents', {
      type: 'document',
      id: mapped,
      title: 'Clouds',
      body: 'Clouds are tiny water droplets held up by rising air.',
      lang: 'en',
      tags: ['weather'],
    });
    const path = `/v1/rag/collections/documents/documents/${mapped}`;
    await vi.waitFor(async () => expect((await api('GET', path)).status).toBe(200), {
      timeout: 120_000,
      interval: 1000,
    });
    publish('rag.documents', { type: 'document', id: mapped, deleted: true });
    await vi.waitFor(async () => expect((await api('GET', path)).status).toBe(404), {
      timeout: 120_000,
      interval: 1000,
    });
  }, 300_000);

  it('refuses what it cannot do, with the error envelope', async () => {
    const missing = await api<ErrorEnvelope>(
      'POST',
      '/v1/rag/collections/no-such-collection/search',
      {
        query: 'anything',
      },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const invalid = await api<ErrorEnvelope>('POST', `${base}/search`, { topK: 3 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_INPUT');

    const regex = await api<ErrorEnvelope>('POST', `${base}/search`, {
      query: 'x',
      filter: { subject: { $regex: '.*' } },
    });
    expect(regex.status).toBe(400);
  });

  it('deletes a document, then drops the collection', async () => {
    const deleted = await ingest(`${base}/documents/fractions`, 'DELETE');
    expect(deleted.documents).toEqual([{ documentId: 'fractions', status: 'deleted' }]);
    expect((await api('GET', `${base}/documents/fractions`)).status).toBe(404);

    const dropped = await ingest(base, 'DELETE');
    expect(dropped.collection).toMatchObject({ name: COLLECTION, dropped: true });
    expect((await api<ErrorEnvelope>('GET', base)).status).toBe(404);
  });

  it('records where each run came from', async () => {
    const { body } = await api<{ runs: RunView[] }>('GET', '/v1/runs?workflow=rag-ingest&limit=50');
    const triggers = new Set(
      body.runs.map((r) => (r.trigger as { type?: string } | undefined)?.type),
    );
    expect(triggers).toContain('rest');
    expect(triggers).toContain('kafka');
  });
});
