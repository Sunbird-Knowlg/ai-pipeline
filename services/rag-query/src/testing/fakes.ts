import type { Embed } from '@ai-pipeline/ai/embed';
import type { GenerateRequest, GenerateResult } from '@ai-pipeline/ai/generate';
import { chunkId } from '@ai-pipeline/rag/ids';
import type { CollectionSettings, DocumentMetadata } from '@ai-pipeline/rag/schemas';
import type { CollectionRef, RagStore } from '@ai-pipeline/rag/store';

/** Test doubles for the store and the models. Not shipped (`src/testing/`). */

export const TEST_SETTINGS: CollectionSettings = {
  description: 'rag-query test collection',
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
    metadataIndexes: [],
  },
};

/** The axes of the fake embedding space: a text is near another when it mentions the same ones. */
export const KEYWORDS = ['light', 'water', 'soil', 'root'] as const;

/** 1 on each keyword's axis that `text` mentions: cosine similarity is keyword overlap. */
export const keywordVector = (text: string): number[] =>
  KEYWORDS.map((keyword) => (text.toLowerCase().includes(keyword) ? 1 : 0));

/** An `Embed` that maps text to `keywordVector`s. */
export const keywordEmbed: Embed = async ({ model, values }) => ({
  embeddings: values.map(keywordVector),
  model,
  dimension: KEYWORDS.length,
  usage: { tokens: values.length },
});

export interface SeedDocument {
  id: string;
  title?: string;
  metadata?: DocumentMetadata;
  chunks: string[];
}

/**
 * Creates `name` and writes `documents` into it the way `rag-ingest` does: chunk metadata is the
 * document's metadata plus the pipeline's own keys, and each chunk's vector is its keyword vector.
 */
export async function seedCollection(
  store: RagStore,
  name: string,
  incarnation: string,
  documents: readonly SeedDocument[],
): Promise<CollectionRef> {
  const ref = await store.ensureCollection({
    name,
    settings: TEST_SETTINGS,
    explicit: true,
    incarnation,
    probeDimension: async () => KEYWORDS.length,
  });
  for (const [n, document] of documents.entries()) {
    const metadata = document.metadata ?? {};
    const fingerprint = `fp:${document.id}`;
    await store.writeDocument(
      ref,
      {
        documentId: document.id,
        fingerprint,
        ...(document.title ? { title: document.title } : {}),
        format: 'text',
        metadata,
        chunks: document.chunks.map((text, i) => ({
          id: chunkId(ref.id, document.id, i),
          vector: keywordVector(text),
          metadata: {
            ...metadata,
            documentId: document.id,
            chunkIndex: i,
            chunkCount: document.chunks.length,
            text,
            ...(document.title ? { title: document.title } : {}),
            format: 'text',
            fingerprint,
            seq: n + 1,
          },
        })),
      },
      { seq: n + 1, runId: 'seed' },
      false,
    );
  }
  return ref;
}

/** Whether a `Generate` request is the reranker's relevance call (`modelScorer`), not an answer. */
export const isScoring = (request: GenerateRequest): boolean =>
  request.prompt.includes('\n<passage>\n');

/** The passage a relevance call asks the model to rate. */
export const scoredText = (prompt: string): string =>
  /<passage>\n([\s\S]*?)\n<\/passage>/.exec(prompt)?.[1] ?? '';

/** A `Generate` result with this text, as the gateway would return it. */
export const generated = (text: string, model: string): GenerateResult => ({
  text,
  model,
  finishReason: 'stop',
  usage: { outputTokens: 1 },
});
