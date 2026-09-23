/**
 * Determinism rules for code that runs inside a Restate handler (`services/*`, `workflows/*`,
 * `packages/runtime`).
 *
 * CLAUDE.md states these rules; until now only the always-replay test could catch a breach, and
 * only after the fact. As lint they fail the build at the line that introduced them.
 *
 * Restate replays a handler from its journal. Anything outside `ctx.run` must therefore return the
 * same value on every replay: the clock, randomness, timers and native promise combinators over
 * durable work do not.
 */
const NON_DETERMINISTIC_PROPERTIES = [
  { object: 'Date', property: 'now', message: 'Use `await ctx.date.now()`: replays must agree.' },
  { object: 'Math', property: 'random', message: 'Use `ctx.rand`: replays must agree.' },
  {
    object: 'Promise',
    property: 'all',
    message: 'Use `RestatePromise.all` over durable work; native combinators break replay.',
  },
  {
    object: 'Promise',
    property: 'allSettled',
    message: 'Use `RestatePromise.allSettled` over durable work.',
  },
  { object: 'Promise', property: 'race', message: 'Use `RestatePromise.race` over durable work.' },
  { object: 'Promise', property: 'any', message: 'Use `RestatePromise.any` over durable work.' },
];

const TIMERS = ['setTimeout', 'setInterval', 'setImmediate'];

export function handlers() {
  return [
    {
      files: ['src/**/*.ts'],
      ignores: ['src/**/*.test.ts'],
      rules: {
        'no-restricted-properties': ['error', ...NON_DETERMINISTIC_PROPERTIES],
        'no-restricted-globals': [
          'error',
          ...TIMERS.map((name) => ({
            name,
            message: 'Use `ctx.sleep()`: a wall-clock timer does not survive replay.',
          })),
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "NewExpression[callee.name='Date'][arguments.length=0]",
            message: 'Use `await ctx.date.now()`: `new Date()` differs on every replay.',
          },
        ],
      },
    },
  ];
}
