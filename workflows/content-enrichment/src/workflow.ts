import { contentEnrichmentApi } from './api.js';
import { summaryApi } from '@ai-pipeline/contract-summary/api';
import { workflowOptions } from '@ai-pipeline/runtime/options';
import * as restate from '@restatedev/restate-sdk';
import { textStats } from './steps.js';
import { config, metadata } from './unit.js';

/**
 * Summarises published content.
 *
 * The shape is deliberately plain Restate: record where the run came from, make one durable call to
 * the private summary service, and derive the rest. Everything non-deterministic goes through the
 * context (`ctx.date.now()`), and the only I/O is inside the service it calls.
 */
export const contentEnrichment = restate.implement(contentEnrichmentApi, {
  handlers: {
    run: async (ctx, { input, trigger }) => {
      // The runs API reads these back; they are recorded by the handler so they survive a replay.
      ctx.set('trigger', trigger);
      ctx.set('version', metadata.version);

      const text = input.title ? `${input.title}\n\n${input.text}` : input.text;

      const { summary, model } = await ctx
        .client(summaryApi)
        .summarize({ text, maxWords: config.summaryMaxWords });

      return {
        contentId: input.contentId,
        summary,
        metadata: {
          ...textStats(input.text),
          model,
          trigger: trigger.type,
          enrichedAt: await ctx.date.now(),
        },
      };
    },
  },
  options: workflowOptions(metadata),
});
