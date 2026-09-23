import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ContractEntry } from './entry.js';
import { canonicalJson, contractHash, contractSchemas } from './schemas.js';

/**
 * The contract kit: turning a unit's zod contract into the JSON Schema the catalogue stores and the
 * hash the version rule compares. It knows nothing about any particular unit — each unit owns its
 * own contract and tests it next to itself.
 */
const entry = (overrides: Partial<ContractEntry> = {}): ContractEntry => ({
  restateName: 'Example',
  handler: 'run',
  input: z.strictObject({ text: z.string().min(1), count: z.number().int().optional() }),
  output: z.strictObject({ ok: z.boolean() }),
  config: z.strictObject({ limit: z.number().int().default(10) }),
  ...overrides,
});

describe('contractSchemas', () => {
  it('emits draft-07 the default Ajv compiles, with no $schema marker', () => {
    const schemas = contractSchemas(entry());
    const ajv = new Ajv({ strict: true, allErrors: true });
    for (const [which, schema] of Object.entries(schemas)) {
      expect(schema, which).not.toHaveProperty('$schema');
      expect(() => ajv.compile(schema), which).not.toThrow();
    }
  });

  it('validates the way zod does, including refusing unknown keys', () => {
    const { input } = contractSchemas(entry());
    const validate = new Ajv({ strict: true }).compile(input);
    expect(validate({ text: 'hello' })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ text: 'hello', extra: 1 })).toBe(false);
  });

  it('describes config as input, so a field with a default may be omitted', () => {
    // This is what lets a unit's metadata.json leave a defaulted setting out: the config schema is
    // what `metadata.config` is validated *against*, so it describes what a caller may supply —
    // not what the value looks like once zod has filled the defaults in.
    const { config } = contractSchemas(entry());
    expect(config.required).toBeUndefined();
    expect(config).toMatchObject({ properties: { limit: { type: 'integer', default: 10 } } });
  });

  it('describes input and output the way each is actually used', () => {
    const schemas = contractSchemas(entry());
    // A required input stays required; that is what the API validates a start request against.
    expect(schemas.input).toMatchObject({ required: ['text'] });
    expect(schemas.output).toMatchObject({ required: ['ok'] });
  });
});

describe('contractHash', () => {
  it('is stable across structurally identical schemas', () => {
    const schemas = contractSchemas(entry());
    expect(contractHash(schemas)).toBe(contractHash(structuredClone(schemas)));
  });

  it('changes when the contract changes', () => {
    const wider = entry({ input: z.strictObject({ text: z.string(), extra: z.string() }) });
    expect(contractHash(contractSchemas(wider))).not.toBe(contractHash(contractSchemas(entry())));
  });

  it('does not depend on key order, which is what makes it safe to compare across builds', () => {
    const a = { input: { type: 'object', title: 'x' }, output: {}, config: {} };
    const b = { input: { title: 'x', type: 'object' }, output: {}, config: {} };
    expect(contractHash(a)).toBe(contractHash(b));
  });
});

describe('canonicalJson', () => {
  it('sorts keys, preserves array order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('handles nesting and the JSON primitives', () => {
    expect(canonicalJson({ z: { y: [1, { x: null }] } })).toBe('{"z":{"y":[1,{"x":null}]}}');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(null)).toBe('null');
  });
});
