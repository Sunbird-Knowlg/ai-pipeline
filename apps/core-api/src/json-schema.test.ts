import { describe, expect, it } from 'vitest';
import { compileOrThrow, validateOnce, validator } from './json-schema.js';

/**
 * The Ajv the control plane validates with. Its schemas come from callers — a deployment submits
 * them and every run start is then checked against one — so the properties worth pinning are the
 * ones that keep a caller from taking the process down or slipping past a constraint.
 */
describe('pattern', () => {
  const schema = (pattern: string) => ({
    type: 'object' as const,
    properties: { x: { type: 'string' as const, pattern } },
  });

  it('still validates ordinary patterns, anchored and not', () => {
    const validate = validator('t:ordinary', schema('^do_[0-9]+$'));
    expect(validate({ x: 'do_123' })).toBe(true);
    expect(validate({ x: 'doc_123' })).toBe(false);

    const search = validator('t:search', schema('[0-9]+'));
    expect(search({ x: 'abc42' })).toBe(true);
    expect(search({ x: 'abc' })).toBe(false);
  });

  it('keeps patterns apart, however many schemas are compiled', () => {
    // Ajv caches compiled patterns in one process-wide scope, keyed on the stringified engine
    // result. An engine whose objects all stringify alike makes every schema share the first
    // pattern compiled — which validates nothing correctly and fails open or closed at random.
    const digits = validator('t:distinct-a', schema('^[0-9]+$'));
    const letters = validator('t:distinct-b', schema('^[a-z]+$'));
    const either = validator('t:distinct-c', schema('^[a-z0-9]+$'));

    expect([digits({ x: '42' }), digits({ x: 'ab' })]).toEqual([true, false]);
    expect([letters({ x: 'ab' }), letters({ x: '42' })]).toEqual([true, false]);
    expect([either({ x: 'a4' }), either({ x: 'A4' })]).toEqual([true, false]);
  });

  it('answers in bounded time on a pattern that makes the native engine backtrack', () => {
    // `^(a+)+$` against 30 a's and a b blocks a native RegExp for ~25 s, and Node is
    // single-threaded, so that is every request in the process, not just this one.
    const validate = validator('t:redos', schema('^(a+)+$'));
    const started = Date.now();
    expect(validate({ x: `${'a'.repeat(40)}b` })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses a pattern the linear-time engine cannot run, at compile time', () => {
    // Backreferences and lookaround are what make a regex super-linear; a contract using one is
    // refused when it is deployed rather than accepted and turned into a denial of service.
    expect(() => compileOrThrow(schema('(?=secret)x'))).toThrow(/Perl syntax|unsupported/i);
    expect(() => compileOrThrow(schema('(a)\\1'))).toThrow();
  });
});

describe('validateOnce', () => {
  it('summarises why a value was refused, pointing at the field', () => {
    const errors = validateOnce(
      { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      { n: 'not a number' },
    );
    expect(errors).toMatch(/\/n/);
  });

  it('returns undefined when the value fits', () => {
    expect(validateOnce({ type: 'object' }, {})).toBeUndefined();
  });
});

describe('validator', () => {
  it('caches by key, so a hot path compiles each contract once', () => {
    const first = validator('t:cache', { type: 'object' });
    expect(validator('t:cache', { type: 'string' })).toBe(first);
  });
});
