import { describe, expect, it } from 'vitest';
import { chunkMetadata, collectionView, documentView, hitView } from './views.js';
import { TEST_SETTINGS } from './testing/fakes.js';

describe('the wire views', () => {
  const metadata = {
    lang: 'en',
    documentTitle: 'Extracted title',
    documentId: 'doc-1',
    chunkIndex: 3,
    chunkCount: 9,
    text: 'Chlorophyll absorbs light.',
    title: 'Leaves',
    format: 'markdown',
    fingerprint: 'sha256:abc',
    seq: 17,
  };

  it('moves the pipeline’s own metadata keys into fields, and keeps the rest', () => {
    expect(chunkMetadata(metadata)).toEqual({ lang: 'en', documentTitle: 'Extracted title' });
    expect(hitView({ id: 'c1', score: 0.75, metadata, vector: [1, 0] })).toEqual({
      id: 'c1',
      score: 0.75,
      documentId: 'doc-1',
      chunkIndex: 3,
      title: 'Leaves',
      text: 'Chlorophyll absorbs light.',
      metadata: { lang: 'en', documentTitle: 'Extracted title' },
      vector: [1, 0],
    });
    expect(
      hitView({ id: 'c2', score: 0.5, metadata: { documentId: 'd', chunkIndex: 0, text: 't' } }),
    ).toEqual({ id: 'c2', score: 0.5, documentId: 'd', chunkIndex: 0, text: 't', metadata: {} });
  });

  it('never exposes a collection’s incarnation or table', () => {
    const view = collectionView({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'docs',
      tableName: 'c_0000000000004000',
      embeddingModel: 'embed-test',
      dimension: 4,
      settings: TEST_SETTINGS,
      documents: 2,
      chunks: 5,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(Object.keys(view).sort()).toEqual([
      'chunks',
      'createdAt',
      'dimension',
      'documents',
      'embeddingModel',
      'name',
      'settings',
      'updatedAt',
    ]);
  });

  it('leaves out a document’s missing title and format rather than sending null', () => {
    const view = documentView({
      documentId: 'doc-1',
      status: 'ready',
      fingerprint: 'sha256:abc',
      chunkCount: 2,
      title: null,
      format: null,
      metadata: { lang: 'en' },
      seq: 3,
      runId: 'run-1',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(view).toEqual({
      documentId: 'doc-1',
      metadata: { lang: 'en' },
      chunkCount: 2,
      fingerprint: 'sha256:abc',
      seq: 3,
      runId: 'run-1',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});
