import { contractSchemas } from '@ai-pipeline/contracts/schemas';
import { RE2JS } from 're2js';
import { describe, expect, it } from 'vitest';
import { contract } from './contract.js';
import { RagIngestConfig, RagIngestInput } from './schemas.js';
import { metadata } from './unit.js';

describe('the rag-ingest contract', () => {
  it('converts to JSON Schema without losing a rule (no refinements)', () => {
    expect(() => contractSchemas(contract)).not.toThrow();
  });

  it('uses only patterns core-api’s RE2 engine compiles (it refuses the contract otherwise)', () => {
    const patterns = (node: unknown): string[] =>
      Array.isArray(node)
        ? node.flatMap(patterns)
        : node && typeof node === 'object'
          ? Object.entries(node).flatMap(([key, value]) =>
              key === 'pattern' && typeof value === 'string' ? [value] : patterns(value),
            )
          : [];
    const found = patterns(contractSchemas(contract));
    expect(found.length).toBeGreaterThan(0);
    for (const pattern of found) expect(() => RE2JS.compile(pattern), pattern).not.toThrow();
  });

  it('accepts the shipped config, mappings included', () => {
    expect(RagIngestConfig.safeParse(metadata.config).success).toBe(true);
  });

  it('names an adapter only where an event mapping exists', () => {
    const config = RagIngestConfig.parse(metadata.config);
    for (const trigger of metadata.triggers)
      if (trigger.type === 'kafka' && trigger.adapter)
        expect(Object.keys(config.eventMappings)).toContain(trigger.adapter);
  });

  it('takes every chunking strategy, and refuses options Mastra would reject', () => {
    const upsert = (chunking: unknown) =>
      RagIngestInput.safeParse({
        operation: 'upsert',
        collection: 'docs',
        documents: [{ id: 'a', text: 'x' }],
        options: { chunking },
      }).success;
    for (const strategy of [
      'recursive',
      'character',
      'token',
      'markdown',
      'semantic-markdown',
      'latex',
    ])
      expect(upsert({ strategy }), strategy).toBe(true);
    expect(upsert({ strategy: 'html', headers: [['h1', 'h1']] })).toBe(true);
    expect(upsert({ strategy: 'json', maxSize: 100 })).toBe(true);
    expect(upsert({ strategy: 'sentence', maxSize: 100 })).toBe(true);
    // Mastra's per-strategy schemas are strict: `separators` is a recursive option, not character's.
    expect(upsert({ strategy: 'character', separators: ['\n'] })).toBe(false);
    expect(upsert({ strategy: 'json' })).toBe(false);
    expect(upsert({ strategy: 'nope' })).toBe(false);
  });

  it('bounds a run: documents and text', () => {
    const documents = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `d${i}`, text: 'x' }));
    const parse = (docs: unknown) =>
      RagIngestInput.safeParse({ operation: 'upsert', collection: 'docs', documents: docs })
        .success;
    expect(parse(documents(100))).toBe(true);
    expect(parse(documents(101))).toBe(false);
    expect(parse([])).toBe(false);
  });
});
