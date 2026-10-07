import { RE2JS } from 're2js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CollectionName,
  CollectionSettings,
  CollectionSettingsInput,
  DocumentId,
  DocumentMetadata,
  MetadataKey,
  readSettings,
  resolveSettings,
  settingsProblems,
} from './schemas.js';
import { TEST_SETTINGS } from './testing/store-contract.js';

describe('names', () => {
  it('accepts collection names that are keys, not identifiers', () => {
    expect(CollectionName.safeParse('diksha-content_v2').success).toBe(true);
    expect(CollectionName.safeParse('Diksha').success).toBe(false);
    expect(CollectionName.safeParse('1x').success).toBe(false);
  });

  it('takes metadata keys Mastra can filter on: at most 63 characters', () => {
    expect(MetadataKey.safeParse(`k${'x'.repeat(62)}`).success).toBe(true);
    expect(MetadataKey.safeParse(`k${'x'.repeat(63)}`).success).toBe(false);
  });

  it('accepts opaque document ids, without control characters', () => {
    expect(DocumentId.safeParse('do_3130 9317/Ä.pdf').success).toBe(true);
    expect(DocumentId.safeParse('a\nb').success).toBe(false);
    expect(DocumentId.safeParse('').success).toBe(false);
  });
});

describe('collection settings', () => {
  it('fills a partial request from the defaults, deeply', () => {
    const input = CollectionSettingsInput.parse({
      embedding: { model: 'embed-other' },
      index: { hnsw: { m: 32 } },
    });
    const settings = resolveSettings(TEST_SETTINGS, input);
    expect(CollectionSettings.parse(settings)).toEqual({
      ...TEST_SETTINGS,
      embedding: { ...TEST_SETTINGS.embedding, model: 'embed-other' },
      index: { ...TEST_SETTINGS.index, hnsw: { m: 32, efConstruction: 64 } },
    });
  });

  it('reports the rules a JSON Schema cannot state', () => {
    expect(settingsProblems(TEST_SETTINGS)).toEqual([]);
    const broken = resolveSettings(TEST_SETTINGS, {
      embedding: { queryTemplate: 'no placeholder', documentTemplate: 'nor here' },
      index: { metadataIndexes: ['documentId'] },
    });
    expect(settingsProblems(broken)).toHaveLength(3);
  });

  it('refuses a flat collection with a metric PgVector would not search it by', () => {
    const flat = (metric: 'cosine' | 'euclidean' | 'dotproduct') =>
      resolveSettings(TEST_SETTINGS, { index: { type: 'flat', metric } });
    expect(settingsProblems(flat('cosine'))).toEqual([]);
    expect(settingsProblems(flat('euclidean'))).toEqual([
      'index.metric: a flat collection is searched by cosine; use hnsw for euclidean',
    ]);
    expect(settingsProblems(flat('dotproduct'))).toHaveLength(1);
  });

  it('reads stored settings a newer unit wrote, dropping the keys it does not know', () => {
    const stored = {
      ...TEST_SETTINGS,
      future: true,
      embedding: { ...TEST_SETTINGS.embedding, normalize: 'l2' },
      index: { ...TEST_SETTINGS.index, hnsw: { ...TEST_SETTINGS.index.hnsw, efSearch: 40 } },
    };
    expect(readSettings(stored)).toEqual(TEST_SETTINGS);
    // The row is left as it was, and anything else wrong still fails.
    expect(stored).toHaveProperty('future', true);
    expect(() =>
      readSettings({ ...TEST_SETTINGS, index: { ...TEST_SETTINGS.index, type: 'ivf' } }),
    ).toThrow();
  });

  it('converts to JSON Schema without refinements, so it can sit in a catalogued contract', () => {
    for (const schema of [CollectionSettings, CollectionSettingsInput])
      expect(() => z.toJSONSchema(schema, { target: 'draft-07', io: 'input' })).not.toThrow();
  });
});

/** Every `pattern` in a JSON Schema, wherever it sits. */
function patterns(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(patterns);
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'pattern' && typeof value === 'string' ? [value] : patterns(value),
  );
}

describe('patterns', () => {
  it('compile under RE2, which core-api uses for every catalogued pattern', () => {
    // A `\u` escape, a lookaround or a backreference would be refused at deploy time
    // (`INVALID_SCHEMA`); catching it here is cheaper.
    const schemas = [
      CollectionName,
      DocumentId,
      MetadataKey,
      DocumentMetadata,
      CollectionSettings,
      CollectionSettingsInput,
    ];
    const found = schemas.flatMap((schema) =>
      patterns(z.toJSONSchema(schema, { target: 'draft-07', io: 'input' })),
    );
    expect(found.length).toBeGreaterThan(2);
    for (const pattern of found) expect(() => RE2JS.compile(pattern), pattern).not.toThrow();
  });
});
