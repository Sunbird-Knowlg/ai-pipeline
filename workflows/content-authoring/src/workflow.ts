import { contentMetadataApi } from '@ai-pipeline/contract-content-metadata/api';
import { quizGenerateApi } from '@ai-pipeline/contract-quiz-generate/api';
import { summaryApi } from '@ai-pipeline/contract-summary/api';
import { workflowOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { contentAuthoringApi } from './api.js';
import type { PackSink } from './publish.js';
import { authoringText, textStats } from './steps.js';
import { config, metadata } from './unit.js';

/**
 * Builds an authoring pack from one DIKSHA content item: a summary, extracted metadata, and a quiz.
 *
 * This is the reference shape for a workflow in this repo. Read top to bottom:
 *
 * 1. record where the run came from, so the runs API can report it;
 * 2. put the input in order with plain deterministic code (`./steps.ts`);
 * 3. call the shared services — durably, in parallel where they are independent and in sequence
 *    where one genuinely needs the other's answer;
 * 4. perform the one side effect this workflow owns, inside `ctx.run` so it happens exactly once;
 * 5. return the pack, which the runs API serves as the run's output.
 *
 * The workflow does no I/O of its own beyond step 4: the model calls live in the services it calls,
 * which is what makes those capabilities reusable and this handler readable. Everything outside
 * `ctx.run` is replayed verbatim on every suspension, so it uses `ctx.date.now()` rather than the
 * wall clock and `RestatePromise.all` rather than `Promise.all`.
 *
 * `publish` is a parameter rather than an import for the same reason `services/summary` takes
 * `generate`: the replay test substitutes a counter and proves the step really ran once.
 */
export function createContentAuthoring(publish: PackSink) {
  return restate.implement(contentAuthoringApi, {
    handlers: {
      run: async (ctx, { input, trigger }) => {
        // The runs API reads these back; they are recorded by the handler so they survive a replay.
        ctx.set('trigger', trigger);
        ctx.set('version', metadata.version);

        // 2. Deterministic, and therefore free to redo on every replay.
        const text = authoringText(input);

        // 3a. Two independent capabilities, so two calls in flight at once. `RestatePromise.all`
        //     journals both; `Promise.all` would settle in whatever order the network happened to
        //     answer in, and a replay would not agree with the first attempt.
        const [summary, extracted] = await restate.RestatePromise.all([
          ctx.client(summaryApi).summarize({ text, maxWords: config.summaryMaxWords }),
          ctx.client(contentMetadataApi).extract({ text, maxKeywords: config.maxKeywords }),
        ]);

        // 3b. The quiz is not independent: it examines the concepts the previous step found, so it
        //     waits for them. A data dependency is the only good reason to give up concurrency.
        const quiz = await ctx.client(quizGenerateApi).generate({
          text,
          questionCount: config.questionCount,
          focus: extracted.concepts,
        });

        const authoredAt = await ctx.date.now();

        // 4. The side effect. Outside `ctx.run` this would be emitted again on every replay; inside
        //    it, Restate records the outcome the first time and skips the body afterwards.
        await ctx.run(
          'publish.pack-ready',
          () =>
            publish({
              contentId: input.contentId,
              name: input.name,
              version: metadata.version,
              trigger: trigger.type,
              difficulty: extracted.difficulty,
              keywords: extracted.keywords.length,
              questions: quiz.questions.length,
              discarded: quiz.discarded,
            }),
          retry.db,
        );

        return {
          contentId: input.contentId,
          name: input.name,
          summary: summary.summary,
          metadata: {
            keywords: extracted.keywords,
            concepts: extracted.concepts,
            difficulty: extracted.difficulty,
            language: input.language,
            ...(input.subject ? { subject: input.subject } : {}),
            ...(input.gradeLevel ? { gradeLevel: input.gradeLevel } : {}),
            ...textStats(text),
          },
          quiz: { questions: quiz.questions, discarded: quiz.discarded },
          provenance: {
            trigger: trigger.type,
            version: metadata.version,
            models: {
              summary: summary.model,
              metadata: extracted.model,
              quiz: quiz.model,
            },
            authoredAt,
          },
        };
      },
    },
    options: workflowOptions(metadata),
  });
}
