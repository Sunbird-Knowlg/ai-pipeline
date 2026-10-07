import { randomUUID } from 'node:crypto';
import * as restate from '@restatedev/restate-sdk';
import { describe, expect, it } from 'vitest';
import { chunkId } from '../ids.js';
import type { CollectionSettings } from '../schemas.js';
import type { CollectionRef, Order, RagStore, WriteDocument } from '../store.js';

/**
 * The behaviour every `RagStore` must have, run against Postgres (`store.pg.test.ts`) and against
 * the in-memory fake (`memory.test.ts`). Writing it once is what keeps the fake faithful: a replay
 * test that passes against the fake proves something about the real store.
 */

export const TEST_SETTINGS: CollectionSettings = {
  description: 'contract test',
  embedding: {
    model: 'embed-test',
    queryTemplate: 'Query: {query}',
    documentTemplate: '{title}\n\n{text}',
  },
  index: {
    metric: 'cosine',
    type: 'hnsw',
    hnsw: { m: 16, efConstruction: 64 },
    vectorType: 'vector',
    metadataIndexes: ['lang'],
  },
};

export const DIMENSION = 4;

/** Unit vectors along one axis, so similarity is unambiguous: axis 0 matches query axis 0. */
export const axis = (i: number): number[] =>
  Array.from({ length: DIMENSION }, (_, j) => (j === i % DIMENSION ? 1 : 0));

export function document(
  ref: CollectionRef,
  documentId: string,
  texts: string[],
  overrides: Partial<WriteDocument> = {},
): WriteDocument {
  return {
    documentId,
    fingerprint: `fp:${texts.join('|')}`,
    title: `Title of ${documentId}`,
    format: 'text',
    metadata: { lang: 'en' },
    chunks: texts.map((text, i) => ({
      id: chunkId(ref.id, documentId, i),
      vector: axis(i),
      metadata: { lang: 'en', documentId, chunkIndex: i, chunkCount: texts.length, text },
    })),
    ...overrides,
  };
}

const order = (seq: number, runId = 'run-a'): Order => ({ seq, runId });

async function rejectsWith(promise: Promise<unknown>, code: number) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(restate.TerminalError);
  expect((error as restate.TerminalError).code).toBe(code);
}

export function storeContract(name: string, store: () => RagStore): void {
  describe(`RagStore contract (${name})`, () => {
    const create = async (settings = TEST_SETTINGS, explicit = true) => {
      const collection = `c-${randomUUID().slice(0, 8)}`;
      const ref = await store().ensureCollection({
        name: collection,
        settings,
        explicit,
        incarnation: randomUUID(),
        probeDimension: async () => DIMENSION,
      });
      return ref;
    };

    it('creates a collection once, and refuses different explicit settings later', async () => {
      const ref = await create();
      expect(ref).toMatchObject({
        created: true,
        dimension: DIMENSION,
        embeddingModel: 'embed-test',
      });
      const again = await store().ensureCollection({
        name: ref.name,
        settings: TEST_SETTINGS,
        explicit: true,
        incarnation: randomUUID(),
        probeDimension: async () => {
          throw new Error('an existing collection is never probed');
        },
      });
      expect(again).toMatchObject({ created: false, id: ref.id });
      const other = { ...TEST_SETTINGS, description: 'changed' };
      await rejectsWith(
        store().ensureCollection({
          name: ref.name,
          settings: other,
          explicit: true,
          incarnation: randomUUID(),
          probeDimension: async () => DIMENSION,
        }),
        409,
      );
      // Without an explicit request, the collection keeps what it has.
      await expect(
        store().ensureCollection({
          name: ref.name,
          settings: other,
          explicit: false,
          incarnation: randomUUID(),
          probeDimension: async () => DIMENSION,
        }),
      ).resolves.toMatchObject({ created: false, settings: TEST_SETTINGS });
    });

    it('refuses to create a collection its model cannot fill', async () => {
      const ensure = (dimension: number, settings = TEST_SETTINGS) =>
        store().ensureCollection({
          name: `c-${randomUUID().slice(0, 8)}`,
          settings,
          explicit: true,
          incarnation: randomUUID(),
          probeDimension: async () => dimension,
        });
      // Empty vectors, a dimension other than the one asked for, one too wide for HNSW on `vector`.
      await rejectsWith(ensure(0), 400);
      const asked = { ...TEST_SETTINGS, embedding: { ...TEST_SETTINGS.embedding, dimensions: 8 } };
      await rejectsWith(ensure(DIMENSION, asked), 400);
      await rejectsWith(ensure(2001), 400);
    });

    it('writes a document, then finds, lists, describes and returns it', async () => {
      const ref = await create();
      await expect(
        store().writeDocument(ref, document(ref, 'doc-1', ['alpha', 'beta']), order(1), false),
      ).resolves.toBe('written');

      const hits = await store().search(ref, axis(1), { topK: 2 });
      expect(hits[0]).toMatchObject({ metadata: { documentId: 'doc-1', text: 'beta' } });
      expect(hits[0]!.score).toBeCloseTo(1);

      const filtered = await store().search(ref, axis(0), { topK: 5, filter: { lang: 'hi' } });
      expect(filtered).toEqual([]);

      await expect(store().getDocument(ref, 'doc-1')).resolves.toMatchObject({
        status: 'ready',
        chunkCount: 2,
        title: 'Title of doc-1',
        seq: 1,
        runId: 'run-a',
      });
      const chunks = await store().documentChunks(ref, 'doc-1');
      expect(chunks.map((c) => [c.chunkIndex, c.text])).toEqual([
        [0, 'alpha'],
        [1, 'beta'],
      ]);
      await expect(store().describeCollection(ref.name)).resolves.toMatchObject({
        documents: 1,
        chunks: 2,
      });
      const listed = await store().listCollections();
      expect(listed.map((c) => c.name)).toContain(ref.name);
    });

    it('replaces a document’s chunks whole: a shorter version leaves no stale tail', async () => {
      const ref = await create();
      await store().writeDocument(ref, document(ref, 'doc', ['a', 'b', 'c']), order(1), false);
      await store().writeDocument(ref, document(ref, 'doc', ['x']), order(2), false);
      const chunks = await store().documentChunks(ref, 'doc');
      expect(chunks.map((c) => c.text)).toEqual(['x']);
    });

    it('lets the newest write win, whatever order the writes land in', async () => {
      const ref = await create();
      await store().writeDocument(ref, document(ref, 'doc', ['v2']), order(2), false);
      await expect(
        store().writeDocument(ref, document(ref, 'doc', ['v1']), order(1), false),
      ).resolves.toBe('superseded');
      // Ties on seq are broken by run id.
      await expect(
        store().writeDocument(ref, document(ref, 'doc', ['v2b']), order(2, 'run-0'), false),
      ).resolves.toBe('superseded');
      expect((await store().documentChunks(ref, 'doc')).map((c) => c.text)).toEqual(['v2']);
    });

    it('settles unchanged content without rewriting it, and moves its order forward', async () => {
      const ref = await create();
      const v1 = document(ref, 'doc', ['same']);
      await store().writeDocument(ref, v1, order(1), false);
      await expect(store().touchDocument(ref, 'doc', v1.fingerprint, order(3))).resolves.toBe(
        'unchanged',
      );
      // An older write with other content, arriving after the newer unchanged one, loses.
      await expect(
        store().writeDocument(ref, document(ref, 'doc', ['older']), order(2), false),
      ).resolves.toBe('superseded');
      await expect(store().touchDocument(ref, 'doc', 'fp:other', order(4))).resolves.toBe(
        'changed',
      );
      await expect(store().writeDocument(ref, v1, order(5), false)).resolves.toBe('unchanged');
      await expect(store().writeDocument(ref, v1, order(6), true)).resolves.toBe('written');
    });

    it('recognises its own earlier write on a retry', async () => {
      const ref = await create();
      const v1 = document(ref, 'doc', ['one']);
      await store().writeDocument(ref, v1, order(1), false);
      await expect(store().touchDocument(ref, 'doc', v1.fingerprint, order(1))).resolves.toBe(
        'written',
      );
      await expect(store().writeDocument(ref, v1, order(1), false)).resolves.toBe('written');
    });

    it('keeps a tombstone, so a late older write cannot bring a deleted document back', async () => {
      const ref = await create();
      await store().writeDocument(ref, document(ref, 'doc', ['a']), order(1), false);
      await expect(store().deleteDocument(ref, 'doc', order(3))).resolves.toBe('deleted');
      await expect(
        store().writeDocument(ref, document(ref, 'doc', ['late']), order(2), false),
      ).resolves.toBe('superseded');
      await expect(store().getDocument(ref, 'doc')).resolves.toBeUndefined();
      await expect(store().search(ref, axis(0), { topK: 5 })).resolves.toEqual([]);
      await expect(store().deleteDocument(ref, 'never', order(1))).resolves.toBe('absent');
      await expect(
        store().writeDocument(ref, document(ref, 'doc', ['newer']), order(4), false),
      ).resolves.toBe('written');
    });

    it('drops a collection, refuses writes through the old reference, and re-creates it fresh', async () => {
      const ref = await create();
      await store().writeDocument(ref, document(ref, 'doc', ['a']), order(1), false);
      await expect(store().dropCollection(ref.name)).resolves.toBe('dropped');
      await expect(store().getCollection(ref.name)).resolves.toBeUndefined();
      await rejectsWith(
        store().writeDocument(ref, document(ref, 'doc', ['b']), order(2), false),
        409,
      );
      await expect(store().dropCollection(ref.name)).resolves.toBe('absent');
      const again = await store().ensureCollection({
        name: ref.name,
        settings: TEST_SETTINGS,
        explicit: true,
        incarnation: randomUUID(),
        probeDimension: async () => DIMENSION,
      });
      expect(again.created).toBe(true);
      expect(again.tableName).not.toBe(ref.tableName);
      await expect(store().describeCollection(ref.name)).resolves.toMatchObject({ documents: 0 });
    });

    it('reads through a dropped reference as Postgres does: no rows, and no vector table', async () => {
      const ref = await create();
      await store().writeDocument(ref, document(ref, 'doc', ['a']), order(1), false);
      await store().dropCollection(ref.name);
      await expect(store().getDocument(ref, 'doc')).resolves.toBeUndefined();
      await expect(store().listDocuments(ref, { limit: 5 })).resolves.toEqual({ documents: [] });
      // Not terminal: a retry looks the collection up again, and reports it gone (a 404).
      for (const read of [
        () => store().search(ref, axis(0), { topK: 1 }),
        () => store().documentChunks(ref, 'doc'),
      ]) {
        const error = await read().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(restate.TerminalError);
      }
    });

    it('pages documents with an opaque cursor', async () => {
      const ref = await create();
      for (const id of ['d1', 'd2', 'd3', 'd4', 'd5'])
        await store().writeDocument(ref, document(ref, id, [id]), order(1), false);
      await store().deleteDocument(ref, 'd3', order(2));
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await store().listDocuments(ref, { limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.documents.map((d) => d.documentId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['d1', 'd2', 'd4', 'd5']);
    });

    it('refuses a cursor it did not hand out', async () => {
      const ref = await create();
      // `AA` decodes to a NUL, which Postgres would refuse as text; the others do not round-trip.
      for (const cursor of ['AA', 'not a cursor', 'ZDE='])
        await rejectsWith(store().listDocuments(ref, { limit: 2, cursor }), 400);
    });
  });
}
