import { workflowOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { ragIngestApi } from './api.js';
import { type DocumentResult, type IngestDeps, ingestDocument, modelFailure } from './ingest.js';
import { planIngest } from './plan.js';
import type { DocumentStatus, RagIngestOutput } from './schemas.js';
import { config, metadata } from './unit.js';
import { inWaves } from './waves.js';

interface Row {
  documentId: string;
  status: DocumentStatus;
  chunks?: number;
  error?: string;
}

/** One row per document, from a wave's settled steps: a terminal failure is that document's alone. */
function rows<R extends { documentId: string; status: DocumentStatus; chunks?: number }>(
  ids: readonly string[],
  settled: PromiseSettledResult<R>[],
): Row[] {
  return settled.map((outcome, i) =>
    outcome.status === 'fulfilled'
      ? outcome.value
      : {
          documentId: ids[i]!,
          status: 'failed',
          error: ((outcome.reason as Error).message ?? String(outcome.reason)).slice(0, 500),
        },
  );
}

function totals(documents: Row[]): RagIngestOutput['totals'] {
  const count = (status: DocumentStatus) => documents.filter((d) => d.status === status).length;
  return {
    written: count('written'),
    unchanged: count('unchanged'),
    superseded: count('superseded'),
    deleted: count('deleted'),
    absent: count('absent'),
    failed: count('failed'),
    chunks: documents.reduce((sum, d) => sum + (d.chunks ?? 0), 0),
  };
}

/**
 * Ingests documents into a RAG collection — or deletes them, or drops the collection.
 *
 * 1. Record where the run came from, then plan it: defaults filled in and every rule a JSON Schema
 *    cannot state checked, deterministically (`./plan.ts`).
 * 2. Make sure the collection exists (`collection.ensure`): created on first use with this run's
 *    settings, its embedding dimension probed; an existing one must match explicit settings.
 * 3. Each document is one durable step (`doc.<i>`): settle it if unchanged, else chunk, extract,
 *    embed and write — vectors go from the model straight to Postgres, never into the journal.
 *    Steps run `limits.documentConcurrency` at a time, and one document failing for good does not
 *    fail the others.
 *
 * Concurrent and out-of-order runs are safe: the store orders writes per document (a producer
 * `version`, else the time the run was received) and the newest wins, whatever lands first.
 *
 * Dependencies are injected so the replay test can count the real calls.
 */
export function createRagIngest(deps: IngestDeps) {
  return restate.implement(ragIngestApi, {
    handlers: {
      run: async (ctx, { input, trigger }) => {
        // The runs API reads these back, and they survive replay because the handler records them.
        ctx.set('trigger', trigger);
        ctx.set('version', metadata.version);
        const provenance = { trigger: trigger.type, version: metadata.version };

        const plan = planIngest(input, config, trigger, ctx.key);

        if (plan.operation === 'drop') {
          const dropped = await ctx.run(
            'collection.drop',
            () => deps.store.dropCollection(plan.collection),
            retry.db,
          );
          return {
            operation: 'drop' as const,
            collection: { name: plan.collection, created: false, dropped: dropped === 'dropped' },
            documents: [],
            totals: totals([]),
            provenance,
          };
        }

        if (plan.operation === 'delete') {
          const ref = await ctx.run(
            'collection.get',
            async () => (await deps.store.getCollection(plan.collection)) ?? null,
            retry.db,
          );
          // Deleting from a collection that does not exist leaves nothing behind either.
          const documents: Row[] = ref
            ? rows(
                plan.documentIds,
                await inWaves(plan.documentIds, config.limits.documentConcurrency, (id, i) =>
                  ctx.run(
                    `doc.${i}.delete`,
                    async () => ({
                      documentId: id,
                      status: await deps.store.deleteDocument(ref, id, plan.order),
                    }),
                    retry.db,
                  ),
                ),
              )
            : plan.documentIds.map((id) => ({ documentId: id, status: 'absent' as const }));
          return {
            operation: 'delete' as const,
            collection: {
              name: plan.collection,
              created: false,
              ...(ref ? { embeddingModel: ref.embeddingModel, dimension: ref.dimension } : {}),
            },
            documents,
            totals: totals(documents),
            provenance,
          };
        }

        // Stable across replays, so a retried `collection.ensure` recognises its own half-made row.
        const incarnation = ctx.rand.uuidv4();
        const ref = await ctx.run(
          'collection.ensure',
          () =>
            deps.store.ensureCollection({
              name: plan.collection,
              settings: plan.settings,
              explicit: plan.explicit,
              incarnation,
              probeDimension: async () => {
                const { model, dimensions } = plan.settings.embedding;
                try {
                  const probe = await deps.embed({
                    model,
                    values: ['dimension probe'],
                    ...(dimensions ? { dimensions } : {}),
                  });
                  return probe.dimension;
                } catch (error) {
                  // An unknown model alias is a 400 from the gateway: fail the run, do not pause it.
                  throw modelFailure(`probing ${model} for its dimension failed`, error);
                }
              },
            }),
          retry.llm,
        );

        // Abandon in-flight model calls when this attempt ends (cancel, suspension, retry).
        const signal = ctx.request().attemptCompletedSignal;
        const settled = await inWaves(plan.documents, config.limits.documentConcurrency, (doc, i) =>
          ctx.run<DocumentResult>(
            `doc.${i}`,
            () => ingestDocument(deps, ref, doc, plan, config.limits, signal),
            retry.llm,
          ),
        );
        const documents = rows(
          plan.documents.map((d) => d.id),
          settled,
        );
        return {
          operation: 'upsert' as const,
          collection: {
            name: ref.name,
            created: ref.created,
            embeddingModel: ref.embeddingModel,
            dimension: ref.dimension,
          },
          documents,
          totals: totals(documents),
          provenance: {
            ...provenance,
            ...(plan.extract ? { extractModel: plan.extract.model } : {}),
          },
        };
      },
    },
    options: workflowOptions(metadata),
  });
}
