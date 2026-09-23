import type { z } from 'zod';

/**
 * The catalogue view of one unit's contract.
 *
 * Every deployable unit exports one of these as `contract` from its own `src/contract.ts`, which the
 * deploy CLI loads from `dist/contract.js`. Keeping it per-unit rather than in a shared registry is
 * what makes units independently deployable: a shared registry would be a file every unit's artifact
 * digest depends on, so adding a workflow would force a version bump of every other one.
 *
 * For a workflow, `input` is the canonical input — the core API wraps it in the run request. For a
 * service it is the input of `handler`.
 */
export interface ContractEntry {
  readonly restateName: string;
  readonly handler: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly config: z.ZodType;
}
