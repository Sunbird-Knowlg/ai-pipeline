import { RESERVED_METADATA } from '@ai-pipeline/rag/schemas';
import type {
  ChunkRecord,
  DocumentRecord,
  CollectionView as StoredCollection,
  Hit as StoredHit,
} from '@ai-pipeline/rag/store';
import type { Chunk, CollectionView, DocumentView, Hit } from './schemas.js';

/**
 * Every store record → wire mapping, in one place. Pure, so the handlers can call these on journaled
 * values as well as inside `ctx.run`. The internal ids (a collection's incarnation and table name)
 * never leave the service.
 */

const RESERVED = new Set<string>(RESERVED_METADATA);

/** A chunk's metadata, without the keys the pipeline writes (each of those has its own field). */
export function chunkMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !RESERVED.has(key)));
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function hitView(hit: StoredHit): Hit {
  const { metadata } = hit;
  const title = text(metadata.title);
  return {
    id: hit.id,
    score: hit.score,
    documentId: text(metadata.documentId),
    chunkIndex: Number(metadata.chunkIndex ?? 0),
    ...(title ? { title } : {}),
    text: text(metadata.text),
    metadata: chunkMetadata(metadata),
    ...(hit.vector ? { vector: hit.vector } : {}),
  };
}

export function collectionView(collection: StoredCollection): CollectionView {
  return {
    name: collection.name,
    embeddingModel: collection.embeddingModel,
    dimension: collection.dimension,
    settings: collection.settings,
    documents: collection.documents,
    chunks: collection.chunks,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

export function documentView(document: DocumentRecord): DocumentView {
  return {
    documentId: document.documentId,
    ...(document.title !== null ? { title: document.title } : {}),
    ...(document.format !== null ? { format: document.format } : {}),
    metadata: document.metadata,
    chunkCount: document.chunkCount,
    // Only a tombstone has no fingerprint, and the store never returns one here.
    fingerprint: document.fingerprint ?? '',
    seq: document.seq,
    runId: document.runId,
    updatedAt: document.updatedAt,
  };
}

export function chunkView(chunk: ChunkRecord): Chunk {
  return {
    id: chunk.id,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    metadata: chunkMetadata(chunk.metadata),
  };
}
