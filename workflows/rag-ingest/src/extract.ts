import type { LanguageModel } from '@ai-pipeline/ai/language-model';
import { MDocument } from '@mastra/rag';
import type { Chunk } from './chunk.js';
import type { ExtractPlan } from './plan.js';

/**
 * Mastra's metadata extractors, run so that one document's extraction stays bounded:
 *
 * - Mastra fires one LLM call per chunk, all at once. Running it over batches of `batchSize`
 *   chunks, one batch after another, is what caps the calls in flight at a local model server.
 * - The title is inferred once, from the first `nodes` chunks, and given to every chunk — a title
 *   per batch would differ from batch to batch.
 * - Summaries are asked for `self` only; `prev` and `next` are then taken from the neighbouring
 *   chunks across the whole document, which per-batch extraction would cut at every boundary.
 *
 * It runs inside the document's `ctx.run`, so it may do I/O and await freely.
 */

/** The Mastra side of one extraction call, injectable so the batching can be tested on its own. */
export type RunExtractors = (
  chunks: Chunk[],
  params: Parameters<MDocument['extractMetadata']>[0],
) => Promise<Record<string, unknown>[]>;

export const mastraExtractors: RunExtractors = async (chunks, params) => {
  const document = new MDocument({
    docs: chunks.map((chunk) => ({ text: chunk.text, metadata: chunk.metadata })),
    type: 'text',
  });
  await document.extractMetadata(params);
  return document.getDocs().map((doc) => ({ ...doc.metadata }));
};

/** Keys the extractors add, and nothing else, so a batch's result cannot overwrite our metadata. */
const EXTRACTED = [
  'documentTitle',
  'sectionSummary',
  'questionsThisExcerptCanAnswer',
  'excerptKeywords',
] as const;

const extracted = (metadata: Record<string, unknown>) =>
  Object.fromEntries(EXTRACTED.filter((key) => key in metadata).map((key) => [key, metadata[key]]));

export async function extractMetadata(
  chunks: Chunk[],
  plan: ExtractPlan,
  model: LanguageModel,
  documentId: string,
  run: RunExtractors = mastraExtractors,
): Promise<Chunk[]> {
  // The extractors accept any AI SDK language model object; Mastra's own type names older specs.
  const llm = model as never;
  const result = chunks.map((chunk) => ({ text: chunk.text, metadata: { ...chunk.metadata } }));

  if (plan.title) {
    const head = result
      .slice(0, plan.title.nodes)
      .map((chunk) => ({ ...chunk, metadata: { ...chunk.metadata, docId: documentId } }));
    const [first] = await run(head, {
      title: {
        llm,
        ...(plan.title.nodeTemplate ? { nodeTemplate: plan.title.nodeTemplate } : {}),
        ...(plan.title.combineTemplate ? { combineTemplate: plan.title.combineTemplate } : {}),
      },
    });
    const title = first?.documentTitle;
    if (typeof title === 'string' && title.trim() !== '')
      for (const chunk of result) chunk.metadata.documentTitle = title.trim();
  }

  const perChunk: Parameters<MDocument['extractMetadata']>[0] = {
    ...(plan.summary
      ? {
          summary: {
            llm,
            summaries: ['self'],
            ...(plan.summary.promptTemplate ? { promptTemplate: plan.summary.promptTemplate } : {}),
          },
        }
      : {}),
    ...(plan.questions
      ? {
          questions: {
            llm,
            questions: plan.questions.questions,
            ...(plan.questions.promptTemplate
              ? { promptTemplate: plan.questions.promptTemplate }
              : {}),
          },
        }
      : {}),
    ...(plan.keywords
      ? {
          keywords: {
            llm,
            keywords: plan.keywords.keywords,
            ...(plan.keywords.promptTemplate
              ? { promptTemplate: plan.keywords.promptTemplate }
              : {}),
          },
        }
      : {}),
  };
  if (Object.keys(perChunk).length > 0)
    for (let start = 0; start < result.length; start += plan.batchSize) {
      const batch = result.slice(start, start + plan.batchSize);
      const metadata = await run(batch, perChunk);
      batch.forEach((chunk, i) => Object.assign(chunk.metadata, extracted(metadata[i] ?? {})));
    }

  if (plan.summary) {
    const wanted = new Set(plan.summary.summaries);
    const summaries = result.map((chunk) => chunk.metadata.sectionSummary);
    result.forEach((chunk, i) => {
      if (wanted.has('prev') && i > 0 && summaries[i - 1])
        chunk.metadata.prevSectionSummary = summaries[i - 1];
      if (wanted.has('next') && i < result.length - 1 && summaries[i + 1])
        chunk.metadata.nextSectionSummary = summaries[i + 1];
      if (!wanted.has('self')) delete chunk.metadata.sectionSummary;
    });
  }
  return result;
}
