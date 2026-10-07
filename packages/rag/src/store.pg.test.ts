import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PgVector } from '@mastra/pg';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRagStore, type CollectionRef, type RagStore } from './store.js';
import {
  axis,
  DIMENSION,
  document,
  storeContract,
  TEST_SETTINGS,
} from './testing/store-contract.js';

/**
 * The store against real Postgres + pgvector, provisioned by the same `30-rag.sql` compose mounts.
 * Runs in the Docker-backed project (`pnpm test:replay`), not with the unit tests.
 */

const PROVISIONING = fileURLToPath(
  new URL('../../../infra/postgres/init/30-rag.sql', import.meta.url),
);
const POOL_MAX = 4;

let container: StartedTestContainer;
let url: string;
let store: RagStore;

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
  url = `postgres://pipeline:pipeline@${container.getHost()}:${container.getMappedPort(5432)}/rag`;
  store = createRagStore({ connectionString: url, poolMax: POOL_MAX });
}, 180_000);

afterAll(async () => {
  await store?.close();
  await container?.stop();
});

storeContract('postgres', () => store);

async function ensure(on: RagStore = store): Promise<CollectionRef> {
  return on.ensureCollection({
    name: `pg-${randomUUID().slice(0, 8)}`,
    settings: TEST_SETTINGS,
    explicit: true,
    incarnation: randomUUID(),
    probeDimension: async () => DIMENSION,
  });
}

async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

describe('the Postgres store, beyond the contract', () => {
  it('converges on the newest content when concurrent writers land out of order', async () => {
    const ref = await ensure();
    const seqs = [7, 2, 11, 0, 5, 9, 1, 10, 3, 8, 4, 6];
    const outcomes = await Promise.all(
      seqs.map((seq) =>
        store.writeDocument(
          ref,
          document(ref, 'doc', [`v${seq}`, `v${seq}-tail`]),
          { seq, runId: 'run' },
          false,
        ),
      ),
    );
    expect(outcomes).toContain('written');
    expect((await store.documentChunks(ref, 'doc')).map((c) => c.text)).toEqual([
      'v11',
      'v11-tail',
    ]);
    await expect(store.getDocument(ref, 'doc')).resolves.toMatchObject({ seq: 11, chunkCount: 2 });
  });

  it('does not deadlock with many more writers than pool connections', async () => {
    const ref = await ensure();
    const ids = Array.from({ length: POOL_MAX * 5 }, (_, i) => `doc-${i}`);
    const outcomes = await Promise.all(
      ids.map((id) =>
        store.writeDocument(ref, document(ref, id, [id]), { seq: 1, runId: 'run' }, false),
      ),
    );
    expect(outcomes.every((o) => o === 'written')).toBe(true);
    await expect(store.describeCollection(ref.name)).resolves.toMatchObject({
      documents: ids.length,
    });
  });

  it('writes rows in the layout Mastra’s PgVector reads', async () => {
    const ref = await ensure();
    const written = document(ref, 'doc', ['a', 'b', 'c']);
    await store.writeDocument(ref, written, { seq: 1, runId: 'run' }, false);
    const mastra = new PgVector({ id: 'reader', connectionString: url, schemaName: 'vectors' });
    try {
      const results = await mastra.query({
        indexName: ref.tableName,
        queryVector: axis(2),
        topK: 3,
      });
      expect(results.map((r) => r.id)).toEqual(
        expect.arrayContaining(written.chunks.map((c) => c.id)),
      );
      expect(results[0]).toMatchObject({ id: written.chunks[2]!.id, metadata: { text: 'c' } });
    } finally {
      await mastra.disconnect();
    }
  });

  it('indexes documentId, so replacing a document is not a table scan', async () => {
    const ref = await ensure();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT 1 FROM vectors."${ref.tableName}" WHERE metadata->>'documentId' = 'x'`,
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Index.*_md_/);
    } finally {
      await client.end();
    }
  });

  it('builds the HNSW index with the settings asked for, not Mastra’s defaults', async () => {
    const ref = await ensure();
    const [index] = await sql<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'vectors' AND tablename = $1 AND indexdef LIKE '%hnsw%'",
      [ref.tableName],
    );
    expect(index?.indexdef).toMatch(/m='?16'?/);
    expect(index?.indexdef).toMatch(/ef_construction='?64'?/);
  });

  it('serves a re-created collection from a new table, even to a process that cached the old one', async () => {
    const other = createRagStore({ connectionString: url, poolMax: 2 });
    try {
      const first = await ensure();
      await store.writeDocument(
        first,
        document(first, 'doc', ['old']),
        { seq: 1, runId: 'r' },
        false,
      );
      // `other` queries the first incarnation, warming its PgVector caches for that table.
      await expect(other.search(first, axis(0), { topK: 1 })).resolves.toHaveLength(1);

      await store.dropCollection(first.name);
      const second = await store.ensureCollection({
        name: first.name,
        settings: TEST_SETTINGS,
        explicit: true,
        incarnation: randomUUID(),
        probeDimension: async () => DIMENSION,
      });
      expect(second.tableName).not.toBe(first.tableName);
      await store.writeDocument(
        second,
        document(second, 'doc', ['new']),
        { seq: 2, runId: 'r' },
        false,
      );

      const fresh = await other.getCollection(first.name);
      const hits = await other.search(fresh!, axis(0), { topK: 1 });
      expect(hits[0]?.metadata.text).toBe('new');
    } finally {
      await other.close();
    }
  });

  it('stores text Postgres would refuse: NUL characters dropped, lone surrogates replaced', async () => {
    const ref = await ensure();
    const dirty = document(ref, 'dirty', ['nul\u0000here', 'half \ud800 pair']);
    dirty.title = 'title\u0000';
    dirty.metadata = { note: 'x\u0000y', tags: ['\udc00'] };
    await expect(store.writeDocument(ref, dirty, { seq: 1, runId: 'r' }, false)).resolves.toBe(
      'written',
    );
    const chunks = await store.documentChunks(ref, 'dirty');
    expect(chunks.map((c) => c.text)).toEqual(['nulhere', 'half \ufffd pair']);
    await expect(store.getDocument(ref, 'dirty')).resolves.toMatchObject({
      title: 'title',
      metadata: { note: 'xy', tags: ['\ufffd'] },
    });
  });

  it('fails a write Postgres refuses for good, instead of retrying it forever', async () => {
    const ref = await ensure();
    const wrong = document(ref, 'wide', ['a']);
    wrong.chunks[0]!.vector = [1, 0, 0, 0, 0]; // one dimension too many for a vector(4) column
    const error = await store
      .writeDocument(ref, wrong, { seq: 1, runId: 'r' }, false)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TerminalError', code: 400 });
    // Nothing half-written: the transaction rolled back.
    await expect(store.getDocument(ref, 'wide')).resolves.toBeUndefined();
  });

  it('drops a collection with writes in flight and leaves nothing behind', async () => {
    const ref = await ensure();
    const big = document(
      ref,
      'big',
      Array.from({ length: 1200 }, (_, i) => `chunk ${i}`),
    );
    const write = store.writeDocument(ref, big, { seq: 1, runId: 'r' }, false).then(
      (outcome) => outcome,
      (error: unknown) => error,
    );
    const drop = store.dropCollection(ref.name);
    const [written] = await Promise.all([write, drop]);
    // The write either finished before the drop took its lock, or was refused after it.
    if (typeof written !== 'string') expect((written as { code: number }).code).toBe(409);
    const [table] = await sql<{ table: string | null }>('SELECT to_regclass($1)::text AS table', [
      `vectors."${ref.tableName}"`,
    ]);
    expect(table?.table).toBeNull();
    await expect(
      sql('SELECT 1 FROM rag_documents WHERE collection_id = $1', [ref.id]),
    ).resolves.toHaveLength(0);
  });
});
