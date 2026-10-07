import type { Embed } from '@ai-pipeline/ai/embed';
import type { Generate } from '@ai-pipeline/ai/generate';
import type { RagStore } from '@ai-pipeline/rag/store';
import { serviceOptions } from '@ai-pipeline/runtime/options';
import * as restate from '@restatedev/restate-sdk';
import { ragQueryApi } from './api.js';
import { NO_HITS_ANSWER, answerPrompt, packEvidence, parseAnswer } from './answer.js';
import { applyRerank, planRetrieval, type RetrievalPlan } from './plan.js';
import { DOCUMENTS_PAGE_DEFAULT, type Hit } from './schemas.js';
import { SCORED_TEXT_MAX, modelFailure, notFound, rerank, retrieve } from './steps.js';
import { config, metadata } from './unit.js';
import { chunkView, collectionView, documentView } from './views.js';

export interface RagQueryDeps {
  store: RagStore;
  embed: Embed;
  /** The answer, and the rerank's relevance scores. */
  generate: Generate;
}

/**
 * Reads, the query embedding and the rerank: a second, quick attempt, then a failure. A caller is
 * waiting on the other end, so this is never the uncapped `retry.llm`, which would pause the
 * invocation instead.
 */
const RETRY_QUERY = {
  maxRetryAttempts: 2,
  initialRetryInterval: { milliseconds: 200 },
  maxRetryInterval: { seconds: 2 },
} satisfies restate.RunOptions<unknown>;

/**
 * Writing the answer is slow; it is not repeated behind a waiting caller's back. With an
 * Idempotency-Key, Restate keeps the outcome, a failure included, for the hour of retention: a retry
 * after a 5xx needs a new key (docs/rag.md).
 */
const RETRY_ANSWER = { maxRetryAttempts: 1 } satisfies restate.RunOptions<unknown>;

/** An answer's length when the caller does not bound it (or the limit, if that is lower). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
/** The least evidence worth asking a model about, once the question and instructions are counted. */
export const MIN_EVIDENCE_CHARS = 500;

/**
 * RagQuery: search, answer, and the read side of collections and documents.
 *
 * Every handler is synchronous for its caller (core-api, through the ingress), and that shapes the
 * options. Invocation retries are few and end in `kill`, not `pause`, because a paused invocation
 * would keep a request open with nobody left to resume it. Journals and idempotency results are
 * kept for an hour, not the pipeline's 7 days, because they hold the caller's queries and the text
 * that answered them.
 *
 * Collaborators are injected so the replay test can run this against an in-memory store and fake
 * models.
 */
export function createRagQueryService(deps: RagQueryDeps) {
  const { store, generate } = deps;

  /** Retrieve, then rerank when asked. `search` and `answer` share it. */
  async function searchSteps(
    ctx: restate.Context,
    plan: RetrievalPlan,
    evidence?: { textMax: number },
  ): Promise<{ embeddingModel: string; hits: Hit[]; reranked: boolean }> {
    // Abandon the model calls when this attempt ends (cancel, suspension, retry).
    const signal = ctx.request().attemptCompletedSignal;
    const retrieved = await ctx.run(
      'retrieve',
      () => retrieve(deps, plan, signal, evidence),
      RETRY_QUERY,
    );
    const { rerank: rerankPlan } = plan;
    if (!rerankPlan || retrieved.hits.length === 0)
      return { ...retrieved, hits: retrieved.hits.slice(0, plan.topK), reranked: false };
    const ranked = await ctx.run(
      'rerank',
      () => rerank(deps, retrieved.hits, { ...plan, rerank: rerankPlan }, signal),
      RETRY_QUERY,
    );
    return { ...retrieved, hits: applyRerank(retrieved.hits, ranked), reranked: true };
  }

  const base = serviceOptions(metadata);
  return restate.implement(ragQueryApi, {
    handlers: {
      search: async (ctx, request) => {
        const plan = planRetrieval(request, config);
        const { embeddingModel, hits, reranked } = await searchSteps(ctx, plan);
        return { collection: request.collection, embeddingModel, hits, reranked };
      },

      answer: async (ctx, request) => {
        const { limits } = config;
        const maxContextChars = request.maxContextChars ?? limits.maxContextChars;
        const maxOutputTokens =
          request.maxOutputTokens ?? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, limits.maxOutputTokens);
        // The question and the instructions are part of what the model reads: evidence gets the rest.
        const asked = request.question.length + (request.instructions?.trim().length ?? 0);
        const evidenceChars = maxContextChars - asked;
        const problems: string[] = [];
        if (maxContextChars > limits.maxContextChars)
          problems.push(`maxContextChars is at most ${limits.maxContextChars}`);
        else if (evidenceChars < MIN_EVIDENCE_CHARS)
          problems.push(
            `maxContextChars (${maxContextChars}) leaves less than ${MIN_EVIDENCE_CHARS} characters of evidence after the question and instructions (${asked})`,
          );
        if (maxOutputTokens > limits.maxOutputTokens)
          problems.push(`maxOutputTokens is at most ${limits.maxOutputTokens}`);
        const plan = planRetrieval(
          { ...request, query: request.question, includeVector: false },
          config,
          problems,
        );
        const model = request.model ?? config.answerModel;
        // No hit is read past the evidence budget, nor scored past what the reranker reads: the
        // retrieve step journals no more than that. One character over the budget keeps a long hit
        // long enough to be cut, and marked as cut, as it would be whole.
        const { hits } = await searchSteps(ctx, plan, {
          textMax: Math.max(evidenceChars + 1, SCORED_TEXT_MAX),
        });
        const sources = packEvidence(hits, evidenceChars);
        // Nothing to ground an answer in: say so without asking a model to invent one.
        if (sources.length === 0)
          return {
            collection: request.collection,
            status: 'insufficient_evidence' as const,
            answer: NO_HITS_ANSWER,
            citations: [],
            model,
          };

        const { system, prompt } = answerPrompt({
          question: request.question,
          sources,
          ...(request.instructions ? { instructions: request.instructions } : {}),
        });
        const signal = ctx.request().attemptCompletedSignal;
        const reply = await ctx.run(
          'llm.answer',
          async () => {
            try {
              const result = await generate({
                model,
                system,
                prompt,
                maxOutputTokens,
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                signal,
              });
              return { text: result.text, truncated: result.finishReason === 'length' };
            } catch (error) {
              throw modelFailure(`answer model ${model}`, error, request.model !== undefined);
            }
          },
          RETRY_ANSWER,
        );
        const parsed = parseAnswer(reply.text, sources);
        return {
          collection: request.collection,
          ...parsed,
          model,
          ...(reply.truncated && parsed.status === 'answered' ? { truncated: true as const } : {}),
        };
      },

      listCollections: async (ctx) => {
        const collections = await ctx.run(
          'collections.list',
          async () => (await store.listCollections()).map(collectionView),
          RETRY_QUERY,
        );
        return { collections };
      },

      getCollection: async (ctx, { collection }) =>
        ctx.run(
          'collection.get',
          async () => {
            const view = await store.describeCollection(collection);
            if (!view) throw notFound(`collection ${collection} not found`);
            return collectionView(view);
          },
          RETRY_QUERY,
        ),

      listDocuments: async (ctx, { collection, limit, cursor }) =>
        ctx.run(
          'documents.list',
          async () => {
            const ref = await store.getCollection(collection);
            if (!ref) throw notFound(`collection ${collection} not found`);
            const page = await store.listDocuments(ref, {
              limit: limit ?? DOCUMENTS_PAGE_DEFAULT,
              ...(cursor ? { cursor } : {}),
            });
            return {
              documents: page.documents.map(documentView),
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
          },
          RETRY_QUERY,
        ),

      getDocument: async (ctx, { collection, documentId, chunks }) =>
        ctx.run(
          'document.get',
          async () => {
            const ref = await store.getCollection(collection);
            if (!ref) throw notFound(`collection ${collection} not found`);
            // The ledger row and the chunks are two reads. A re-ingest landing between them would
            // mix two versions, so the pair is read again until the chunks match the row.
            for (let read = 0; read < 3; read++) {
              const document = await store.getDocument(ref, documentId);
              if (!document)
                throw notFound(`document ${documentId} not found in collection ${collection}`);
              const view = documentView(document);
              if (!chunks) return view;
              const records = await store.documentChunks(ref, documentId);
              const current = records.every(
                ({ metadata }) =>
                  metadata.fingerprint === undefined ||
                  metadata.fingerprint === document.fingerprint,
              );
              if (current && records.length === document.chunkCount)
                return { ...view, chunks: records.map(chunkView) };
            }
            throw new Error(`document ${documentId} kept changing while it was read`);
          },
          RETRY_QUERY,
        ),
    },
    options: {
      ...base,
      retryPolicy: { ...base.retryPolicy, maxAttempts: 3, onMaxAttempts: 'kill' },
      journalRetention: { hours: 1 },
      idempotencyRetention: { hours: 1 },
    },
  });
}
