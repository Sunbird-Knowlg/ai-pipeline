import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DocumentMetadata } from '@ai-pipeline/rag/schemas';
import { createRagStore, type CollectionRef, type RagStore } from '@ai-pipeline/rag/store';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterProblems } from './filter.js';
import { KEYWORDS, TEST_SETTINGS } from './testing/fakes.js';

/**
 * Every filter shape the whitelist accepts, compiled by Mastra and run by real Postgres + pgvector,
 * with the chunks it must match. The in-memory store understands only equality and `$in`, so this
 * is where `filter.ts` meets the SQL it lets through. Runs in the Docker-backed project
 * (`pnpm test:replay`).
 */

const PROVISIONING = fileURLToPath(
  new URL('../../../infra/postgres/init/30-rag.sql', import.meta.url),
);

let container: StartedTestContainer;
let store: RagStore;
let ref: CollectionRef;

/** Three documents of one chunk each, between them every kind of metadata value. */
const DOCUMENTS: Record<string, DocumentMetadata> = {
  a: { lang: 'en', grade: 7, tags: ['biology', 'plants'], draft: false },
  b: { lang: 'hi', grade: 8, tags: ['physics'], draft: true },
  c: { lang: 'en', grade: 6 },
};

beforeAll(async () => {
  container = await new GenericContainer('pgvector/pgvector:0.8.6-pg17-bookworm')
    .withEnvironment({
      POSTGRES_USER: 'pipeline',
      POSTGRES_PASSWORD: 'pipeline',
      POSTGRES_DB: 'pipeline',
    })
    .withCopyFilesToContainer([
      { source: PROVISIONING, target: '/docker-entrypoint-initdb.d/30-rag.sql' },
    ])
    .withExposedPorts(5432)
    // The official image restarts Postgres once after running the init scripts.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  store = createRagStore({
    connectionString: `postgres://pipeline:pipeline@${container.getHost()}:${container.getMappedPort(5432)}/rag`,
  });
  ref = await store.ensureCollection({
    name: 'filters',
    settings: TEST_SETTINGS,
    explicit: true,
    incarnation: randomUUID(),
    probeDimension: async () => KEYWORDS.length,
  });
  for (const [documentId, metadata] of Object.entries(DOCUMENTS))
    await store.writeDocument(
      ref,
      {
        documentId,
        fingerprint: `fp:${documentId}`,
        format: 'text',
        metadata,
        chunks: [
          {
            id: randomUUID(),
            vector: [1, 0, 0, 0],
            metadata: { ...metadata, documentId, chunkIndex: 0, chunkCount: 1, text: documentId },
          },
        ],
      },
      { seq: 1, runId: 'seed' },
      false,
    );
}, 180_000);

afterAll(async () => {
  await store?.close();
  await container?.stop();
});

describe('accepted filters, on real Postgres', () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    ['equality', { lang: 'en' }, ['a', 'c']],
    ['equality on a number', { grade: 7 }, ['a']],
    ['equality on a boolean', { draft: true }, ['b']],
    ['a range', { grade: { $gt: 6, $lt: 8 } }, ['a']],
    ['a bound', { grade: { $gte: 7 } }, ['a', 'b']],
    ['$ne, which leaves out chunks without the key', { draft: { $ne: true } }, ['a']],
    ['$in on an array field', { tags: { $in: ['physics', 'chemistry'] } }, ['b']],
    ['a bare array, read as $in', { tags: ['biology'] }, ['a']],
    ['$in with numbers', { grade: { $in: [7, 8] } }, ['a', 'b']],
    ['$nin, which leaves out chunks without the key', { tags: { $nin: ['physics'] } }, ['a']],
    ['$all, of strings', { tags: { $all: ['biology', 'plants'] } }, ['a']],
    ['$size', { tags: { $size: 2 } }, ['a']],
    ['$exists', { draft: { $exists: false } }, ['c']],
    ['$eq null, which matches a missing key', { draft: { $eq: null } }, ['c']],
    ['$or', { $or: [{ lang: 'hi' }, { grade: 6 }] }, ['b', 'c']],
    ['$and', { $and: [{ lang: 'en' }, { grade: { $lt: 7 } }] }, ['c']],
    ['$nor', { $nor: [{ lang: 'en' }] }, ['b']],
    ['$not over a filter', { $not: { lang: 'en' } }, ['b']],
    ['$not over operators', { grade: { $not: { $gte: 7 } } }, ['c']],
  ];

  it.each(cases)('%s', async (_what, filter, expected) => {
    expect(filterProblems(filter)).toEqual([]);
    const hits = await store.search(ref, [1, 0, 0, 0], { topK: 10, filter });
    expect(hits.map((hit) => hit.metadata.documentId).sort()).toEqual(expected);
  });
});
