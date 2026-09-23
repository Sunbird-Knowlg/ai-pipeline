import { workflowOptions } from '@ai-pipeline/runtime/options';
import * as restate from '@restatedev/restate-sdk';
import { versionedSleeperApi } from './api.js';
import { config, metadata } from './unit.js';

/**
 * Test-only workflow for the versioning and crash e2e suites. `hold` waits on a durable promise, so
 * a test can keep a run in flight for exactly as long as it needs without depending on timing.
 */
export const versionedSleeper = restate.implement(versionedSleeperApi, {
  handlers: {
    run: async (ctx, { input, trigger }) => {
      ctx.set('trigger', trigger);
      ctx.set('version', metadata.version);
      if (input.hold) await ctx.promise<boolean>('release');
      else await ctx.sleep({ seconds: input.seconds }, 'hold');
      return { version: config.version, sleptSeconds: input.seconds };
    },
    release: async (ctx) => {
      await ctx.promise<boolean>('release').resolve(true);
    },
  },
  options: workflowOptions(metadata),
});
