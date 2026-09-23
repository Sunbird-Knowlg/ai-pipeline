import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { ContentInput } from './content-enrichment/schemas.js';
import { contracts } from './registry.js';
import { contractHash, contractSchemas } from './schemas.js';
import { SummaryInput } from './summary/schemas.js';

describe('contract schemas', () => {
  it.each(Object.keys(contracts))('%s compiles as draft-07 with the default Ajv', (name) => {
    const schemas = contractSchemas(contracts[name]!);
    const ajv = new Ajv({ strict: true, allErrors: true });
    for (const schema of Object.values(schemas)) expect(() => ajv.compile(schema)).not.toThrow();
  });

  it('validates content-enrichment input like zod does', () => {
    const { input } = contractSchemas(contracts['content-enrichment']!);
    const validate = new Ajv({ strict: true }).compile(input);
    expect(validate({ contentId: 'c-1', text: 'hello' })).toBe(true);
    expect(validate({ contentId: 'c-1' })).toBe(false);
    expect(validate({ contentId: 'c-1', text: 'x', extra: 1 })).toBe(false);
  });

  it('hashes deterministically and detects changes', () => {
    const a = contractSchemas(contracts.summary!);
    expect(contractHash(a)).toBe(contractHash(structuredClone(a)));
    expect(contractHash(a)).not.toBe(
      contractHash(contractSchemas(contracts['content-enrichment']!)),
    );
  });
});

describe('cross-contract limits', () => {
  it('the largest valid ContentInput still fits SummaryInput (title + blank line + text)', () => {
    const input = ContentInput.parse({
      contentId: 'c',
      title: 't'.repeat(1000),
      text: 'x'.repeat(100_000),
    });
    const text = `${input.title}\n\n${input.text}`;
    expect(SummaryInput.safeParse({ text, maxWords: 1000 }).success).toBe(true);
  });
});
