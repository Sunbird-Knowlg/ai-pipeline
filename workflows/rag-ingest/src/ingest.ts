import type { Embed } from '@ai-pipeline/ai/embed';
import { isRetryableModelError } from '@ai-pipeline/ai/errors';
import type { LanguageModels } from '@ai-pipeline/ai/language-model';
import { chunkId, fingerprint, renderTemplate } from '@ai-pipeline/rag/ids';
import type { CollectionRef, RagStore, WriteOutcome } from '@ai-pipeline/rag/store';
import * as restate from '@restatedev/restate-sdk';
import { type Chunk, chunkDocument } from './chunk.js';
import { extractMetadata, type RunExtractors } from './extract.js';
import type { PlannedDocument, UpsertPlan } from './plan.js';

/** What the per-document step talks to; injected so the replay test can count real calls. */
export interface IngestDeps {
  store: RagStore;
  embed: Embed;
  languageModels: LanguageModels;
  /** Mastra's extractors unless a test substitutes them. */
  extractors?: RunExtractors;
}

export interface Limits {
  maxChunksPerDocument: number;
  maxExtractChunks: number;
}

export interface DocumentResult {
  documentId: string;
  status: WriteOutcome;
  chunks?: number;
}

const terminal = (message: string, errorCode = 400) =>
  new restate.TerminalError(message, { errorCode });

/**
 * A failed model call: retried by Restate when worth it (`retry.llm` is uncapped), otherwise a
 * `TerminalError`, so a request no retry can fix fails instead of pausing the run.
 */
export function modelFailure(what: string, error: unknown): Error {
  if (isRetryableModelError(error)) return error as Error;
  return terminal(`${what}: ${(error as Error).message}`);
}

/**
 * Everything that decides what a document's chunks are. Equal fingerprints mean re-indexing would
 * write the same vectors, so the document is settled as `unchanged` instead.
 */
export function documentFingerprint(
  ref: CollectionRef,
  document: PlannedDocument,
  plan: Pick<UpsertPlan, 'extract'>,
): string {
  return fingerprint({
    text: document.text,
    format: document.format,
    title: document.title ?? null,
    metadata: document.metadata,
    chunking: document.chunking,
    extract: plan.extract ?? null,
    embedding: ref.settings.embedding,
    model: ref.embeddingModel,
  });
}

/**
 * One document, start to finish, in one `ctx.run`: decide whether it needs work, chunk it (and
 * extract metadata), embed the chunks, and write vectors and ledger in one transaction.
 *
 * Doing all of it in one step keeps the vectors out of the Restate journal — only the small result
 * is recorded. A retry redoes the step whole, which is safe: chunk ids are deterministic, and the
 * store's write replaces the document atomically and recognises its own earlier commit.
 */
export async function ingestDocument(
  deps: IngestDeps,
  ref: CollectionRef,
  document: PlannedDocument,
  plan: Pick<UpsertPlan, 'extract' | 'embeddingBatchSize' | 'force'>,
  limits: Limits,
  signal?: AbortSignal,
): Promise<DocumentResult> {
  const fp = documentFingerprint(ref, document, plan);
  if (!plan.force) {
    const settled = await deps.store.touchDocument(ref, document.id, fp, document.order);
    if (settled !== 'changed') return { documentId: document.id, status: settled };
  }

  let chunks: Chunk[];
  try {
    chunks = await chunkDocument(document, document.chunking);
  } catch (error) {
    throw terminal(`document ${document.id} could not be chunked: ${(error as Error).message}`);
  }
  if (chunks.length === 0) throw terminal(`document ${document.id} has no text to index`);
  if (chunks.length > limits.maxChunksPerDocument)
    throw terminal(
      `document ${document.id} makes ${chunks.length} chunks; the limit is ${limits.maxChunksPerDocument} — raise maxSize, or split the document`,
    );

  if (plan.extract) {
    if (chunks.length > limits.maxExtractChunks)
      throw terminal(
        `document ${document.id} makes ${chunks.length} chunks; extraction is limited to ${limits.maxExtractChunks}`,
      );
    try {
      chunks = await extractMetadata(
        chunks,
        plan.extract,
        deps.languageModels(plan.extract.model),
        document.id,
        deps.extractors,
      );
    } catch (error) {
      throw modelFailure(`metadata extraction failed for ${document.id}`, error);
    }
  }

  const texts = chunks.map((chunk) =>
    renderTemplate(ref.settings.embedding.documentTemplate, {
      ...chunk.metadata,
      title: document.title,
      text: chunk.text,
    }),
  );
  let vectors: number[][];
  try {
    const result = await deps.embed({
      model: ref.embeddingModel,
      values: texts,
      batchSize: plan.embeddingBatchSize,
      ...(ref.settings.embedding.dimensions
        ? { dimensions: ref.settings.embedding.dimensions }
        : {}),
      ...(signal ? { signal } : {}),
    });
    vectors = result.embeddings;
  } catch (error) {
    throw modelFailure(`embedding failed for ${document.id}`, error);
  }
  if (vectors.some((vector) => vector.length !== ref.dimension))
    throw terminal(
      `${ref.embeddingModel} now returns vectors of another size than the collection's ${ref.dimension}; ` +
        'was its LiteLLM alias remapped? A collection is bound to one model for life',
    );

  const rows = chunks.map((chunk, i) => ({
    id: chunkId(ref.id, document.id, i),
    vector: vectors[i]!,
    metadata: {
      ...document.metadata,
      ...chunk.metadata,
      // Pipeline-owned keys last, so nothing upstream can overwrite them.
      documentId: document.id,
      chunkIndex: i,
      chunkCount: chunks.length,
      text: chunk.text,
      ...(document.title ? { title: document.title } : {}),
      format: document.format,
      fingerprint: fp,
      seq: document.order.seq,
    },
  }));
  const status = await deps.store.writeDocument(
    ref,
    {
      documentId: document.id,
      fingerprint: fp,
      ...(document.title ? { title: document.title } : {}),
      format: document.format,
      metadata: document.metadata,
      chunks: rows,
    },
    document.order,
    plan.force,
  );
  return {
    documentId: document.id,
    status,
    ...(status === 'written' ? { chunks: rows.length } : {}),
  };
}
