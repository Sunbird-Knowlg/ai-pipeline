import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { runRequest } from '@ai-pipeline/contracts/trigger';
import { z } from 'zod';

/**
 * The catalogue half of this fixture's contract: zod only, no Restate SDK.
 *
 * It lives here rather than in `@ai-pipeline/contracts` so that changing the fixture never alters a
 * production unit's artifact. The deploy CLI picks `contract` up from `dist/contract.js`, and it has
 * no business loading the Restate SDK to read a schema — hence the split from `./api.ts`.
 */
export const SleeperInput = z.strictObject({
  seconds: z.number().int().min(0).max(600),
  /** Wait for the `release` signal (a durable promise) instead of sleeping. */
  hold: z.boolean().optional(),
});
export const SleeperOutput = z.strictObject({
  version: z.string(),
  sleptSeconds: z.number().int(),
});
export const SleeperConfig = z.strictObject({ version: z.string() });

export const SleeperRequest = runRequest(SleeperInput);

/** Catalogue view, picked up by `pipeline deploy` from `dist/contract.js`. */
export const contract: ContractEntry = {
  restateName: 'VersionedSleeper',
  handler: 'run',
  input: SleeperInput,
  output: SleeperOutput,
  config: SleeperConfig,
};
