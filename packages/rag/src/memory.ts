import * as restate from '@restatedev/restate-sdk';
import { canonicalJson } from '@ai-pipeline/contracts/schemas';
import { tableName } from './ids.js';
import { dimensionProblem } from './schemas.js';
import type {
  ChunkRecord,
  CollectionRef,
  CollectionView,
  DocumentRecord,
  Hit,
  Order,
  RagStore,
} from './store.js';
import { decodeCursor, encodeCursor, newer } from './store.js';

/**
 * An in-memory `RagStore` with the Postgres store's semantics — newest-wins ordering, tombstones,
 * unchanged-advances-order, settings that are fixed for life — for the units' replay tests (and
 * local experiments). The contract suite in `./testing/store-contract.ts` runs against both, which
 * is what keeps this one honest. Exported rather than kept in `src/testing/`, because other
 * packages' tests import it and a test-only export would have no types to build against.
 */

interface Collection {
  ref: CollectionRef;
  createdAt: string;
  updatedAt: string;
  documents: Map<string, DocumentRecord>;
  chunks: Map<string, { id: string; vector: number[]; metadata: Record<string, unknown> }[]>;
}

const terminal = (message: string, errorCode: number) =>
  new restate.TerminalError(message, { errorCode });

const sameOrder = (a: Order, b: Order) => a.seq === b.seq && a.runId === b.runId;

function score(metric: string, a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
    sq += (a[i]! - b[i]!) ** 2;
  }
  if (metric === 'dotproduct') return dot;
  if (metric === 'euclidean') return 1 / (1 + Math.sqrt(sq));
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Equality filters on top-level keys (and `$in`), enough for tests. */
function matches(metadata: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(filter ?? {})) {
    const value = metadata[key];
    if (condition && typeof condition === 'object' && '$in' in condition) {
      const options = (condition as { $in: unknown[] }).$in;
      if (!options.includes(value)) return false;
    } else if (value !== condition) return false;
  }
  return true;
}

export interface MemoryRagStore extends RagStore {
  /** Calls made, by method, for assertions. */
  calls: Record<string, number>;
}

export function memoryRagStore(): MemoryRagStore {
  const byName = new Map<string, Collection>();
  const calls: Record<string, number> = {};
  const count = (method: string) => {
    calls[method] = (calls[method] ?? 0) + 1;
  };
  const now = () => new Date(0).toISOString();
  const live = (ref: CollectionRef): Collection => {
    const collection = byName.get(ref.name);
    if (collection?.ref.id !== ref.id)
      throw terminal(
        `collection ${ref.name} was dropped (or re-created) while this run was writing to it`,
        409,
      );
    return collection;
  };
  /**
   * A read through a reference to a dropped (or re-created) collection finds what Postgres would:
   * no ledger rows (they went with the registry row), and no vector table — an error that is not
   * terminal, because a retry looks the collection up again and reports it gone.
   */
  const current = (ref: CollectionRef): Collection | undefined => {
    const collection = byName.get(ref.name);
    return collection?.ref.id === ref.id ? collection : undefined;
  };
  const noTable = (ref: CollectionRef) =>
    Object.assign(new Error(`relation "vectors.${ref.tableName}" does not exist`), {
      code: '42P01',
    });
  const view = (c: Collection): CollectionView => {
    const ready = [...c.documents.values()].filter((d) => d.status === 'ready');
    return {
      ...c.ref,
      documents: ready.length,
      chunks: ready.reduce((sum, d) => sum + d.chunkCount, 0),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  };

  return {
    calls,

    async ensureCollection({ name, settings, explicit, incarnation, probeDimension }) {
      count('ensureCollection');
      const existing = byName.get(name);
      if (existing) {
        if (explicit && canonicalJson(existing.ref.settings) !== canonicalJson(settings))
          throw terminal(`collection ${name} exists with different settings`, 409);
        return { ...existing.ref, created: false };
      }
      const dimension = await probeDimension();
      const problem = dimensionProblem(settings, dimension);
      if (problem) throw terminal(problem, 400);
      const ref: CollectionRef = {
        id: incarnation,
        name,
        tableName: tableName(incarnation),
        embeddingModel: settings.embedding.model,
        dimension,
        settings,
      };
      byName.set(name, {
        ref,
        createdAt: now(),
        updatedAt: now(),
        documents: new Map(),
        chunks: new Map(),
      });
      return { ...ref, created: true };
    },

    async getCollection(name) {
      count('getCollection');
      return byName.get(name)?.ref;
    },

    async describeCollection(name) {
      count('describeCollection');
      const collection = byName.get(name);
      return collection && view(collection);
    },

    async listCollections() {
      count('listCollections');
      return [...byName.values()].sort((a, b) => (a.ref.name < b.ref.name ? -1 : 1)).map(view);
    },

    async touchDocument(ref, documentId, fingerprint, order) {
      count('touchDocument');
      const row = live(ref).documents.get(documentId);
      if (!row) return 'changed';
      if (newer(row, order)) return 'superseded';
      if (row.status !== 'ready' || row.fingerprint !== fingerprint) return 'changed';
      if (sameOrder(row, order)) return 'written';
      row.seq = order.seq;
      row.runId = order.runId;
      return 'unchanged';
    },

    async writeDocument(ref, document, order, force) {
      count('writeDocument');
      const collection = live(ref);
      const row = collection.documents.get(document.documentId);
      if (row) {
        if (newer(row, order)) return 'superseded';
        const same = row.status === 'ready' && row.fingerprint === document.fingerprint;
        if (same && sameOrder(row, order)) return 'written';
        if (same && !force) {
          row.seq = order.seq;
          row.runId = order.runId;
          return 'unchanged';
        }
      }
      collection.chunks.set(document.documentId, document.chunks);
      collection.documents.set(document.documentId, {
        documentId: document.documentId,
        status: 'ready',
        fingerprint: document.fingerprint,
        chunkCount: document.chunks.length,
        title: document.title ?? null,
        format: document.format,
        metadata: document.metadata,
        seq: order.seq,
        runId: order.runId,
        updatedAt: now(),
      });
      return 'written';
    },

    async deleteDocument(ref, documentId, order) {
      count('deleteDocument');
      const collection = live(ref);
      const row = collection.documents.get(documentId);
      if (row && newer(row, order)) return 'superseded';
      const had = row?.status === 'ready';
      collection.chunks.delete(documentId);
      collection.documents.set(documentId, {
        documentId,
        status: 'deleted',
        fingerprint: null,
        chunkCount: 0,
        title: row?.title ?? null,
        format: row?.format ?? null,
        metadata: row?.metadata ?? {},
        seq: order.seq,
        runId: order.runId,
        updatedAt: now(),
      });
      return had ? 'deleted' : 'absent';
    },

    async dropCollection(name) {
      count('dropCollection');
      return byName.delete(name) ? 'dropped' : 'absent';
    },

    async search(ref, vector, { topK, filter, includeVector }) {
      count('search');
      const collection = current(ref);
      if (!collection) throw noTable(ref);
      const hits: Hit[] = [];
      for (const chunks of collection.chunks.values())
        for (const chunk of chunks)
          if (matches(chunk.metadata, filter))
            hits.push({
              id: chunk.id,
              score: score(ref.settings.index.metric, vector, chunk.vector),
              metadata: chunk.metadata,
              ...(includeVector ? { vector: chunk.vector } : {}),
            });
      return hits.sort((a, b) => b.score - a.score).slice(0, topK);
    },

    async listDocuments(ref, { limit, cursor }) {
      count('listDocuments');
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      const ready = [...(current(ref)?.documents.values() ?? [])]
        .filter((d) => d.status === 'ready' && (after === undefined || d.documentId > after))
        .sort((a, b) => (a.documentId < b.documentId ? -1 : 1));
      const page = ready.slice(0, limit);
      return {
        documents: page,
        ...(ready.length > limit
          ? { nextCursor: encodeCursor(page[page.length - 1]!.documentId) }
          : {}),
      };
    },

    async getDocument(ref, documentId) {
      count('getDocument');
      const row = current(ref)?.documents.get(documentId);
      return row?.status === 'ready' ? row : undefined;
    },

    async documentChunks(ref, documentId): Promise<ChunkRecord[]> {
      count('documentChunks');
      const collection = current(ref);
      if (!collection) throw noTable(ref);
      return (collection.chunks.get(documentId) ?? [])
        .map((chunk) => ({
          id: chunk.id,
          chunkIndex: Number(chunk.metadata.chunkIndex),
          text: typeof chunk.metadata.text === 'string' ? chunk.metadata.text : '',
          metadata: chunk.metadata,
        }))
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    },

    async close() {
      count('close');
    },
  };
}
