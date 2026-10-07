import * as restate from '@restatedev/restate-sdk';

/**
 * Runs one durable step per item, `size` at a time, and settles each on its own.
 *
 * Each `step` must return a single Restate promise (one `ctx.run`): `RestatePromise.allSettled`
 * journals the steps of a wave together and replays them in the same order, which a native
 * combinator would not. A step that ends in a `TerminalError` settles as `rejected` without
 * failing the others; a retryable failure is retried by Restate inside its step.
 */
export async function inWaves<T, R>(
  items: readonly T[],
  size: number,
  step: (item: T, index: number) => restate.RestatePromise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const settled: PromiseSettledResult<R>[] = [];
  for (let start = 0; start < items.length; start += size) {
    const wave = items.slice(start, start + size).map((item, i) => step(item, start + i));
    settled.push(...(await restate.RestatePromise.allSettled(wave)));
  }
  return settled;
}
