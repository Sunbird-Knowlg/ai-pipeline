import { describe, expect, it } from 'vitest';
import {
  ContentMetadataConfig,
  ContentMetadataInput,
  ContentMetadataOutput,
  METADATA_TEXT_MAX,
} from './schemas.js';

/** The content-metadata contract. Shared, because `content-authoring` calls this service. */
describe('ContentMetadataInput', () => {
  it('requires text and a keyword budget in range', () => {
    expect(ContentMetadataInput.safeParse({ text: 'hi', maxKeywords: 8 }).success).toBe(true);
    expect(ContentMetadataInput.safeParse({ text: '', maxKeywords: 8 }).success).toBe(false);
    expect(ContentMetadataInput.safeParse({ text: 'hi', maxKeywords: 2 }).success).toBe(false);
    expect(ContentMetadataInput.safeParse({ text: 'hi', maxKeywords: 21 }).success).toBe(false);
  });

  it('refuses unknown keys, so a caller cannot smuggle fields past the contract', () => {
    expect(
      ContentMetadataInput.safeParse({ text: 'hi', maxKeywords: 8, locale: 'en' }).success,
    ).toBe(false);
  });

  it('accepts text up to the documented maximum and no further', () => {
    const at = 'x'.repeat(METADATA_TEXT_MAX);
    expect(ContentMetadataInput.safeParse({ text: at, maxKeywords: 8 }).success).toBe(true);
    expect(ContentMetadataInput.safeParse({ text: `${at}y`, maxKeywords: 8 }).success).toBe(false);
  });
});

describe('ContentMetadataOutput', () => {
  const valid = { keywords: ['photosynthesis'], concepts: ['energy'], difficulty: 'beginner' };

  it('reports which model produced it', () => {
    expect(ContentMetadataOutput.safeParse({ ...valid, model: 'chat-default' }).success).toBe(true);
    expect(ContentMetadataOutput.safeParse(valid).success).toBe(false);
  });

  it('only admits a difficulty from the closed set', () => {
    expect(
      ContentMetadataOutput.safeParse({ ...valid, difficulty: 'hard', model: 'm' }).success,
    ).toBe(false);
  });

  it('caps both lists, so one verbose reply cannot become an unbounded payload', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);
    expect(
      ContentMetadataOutput.safeParse({ ...valid, keywords: many(20), model: 'm' }).success,
    ).toBe(true);
    expect(
      ContentMetadataOutput.safeParse({ ...valid, keywords: many(21), model: 'm' }).success,
    ).toBe(false);
    expect(
      ContentMetadataOutput.safeParse({ ...valid, concepts: many(9), model: 'm' }).success,
    ).toBe(false);
  });

  it('accepts empty lists: a text may genuinely have nothing worth extracting', () => {
    expect(
      ContentMetadataOutput.safeParse({
        keywords: [],
        concepts: [],
        difficulty: 'beginner',
        model: 'm',
      }).success,
    ).toBe(true);
  });
});

describe('ContentMetadataConfig', () => {
  it('defaults the output budget rather than requiring every unit to state it', () => {
    expect(ContentMetadataConfig.parse({ model: 'chat-default' })).toEqual({
      model: 'chat-default',
      maxOutputTokens: 512,
    });
  });

  it('requires a model', () => {
    expect(ContentMetadataConfig.safeParse({}).success).toBe(false);
    expect(ContentMetadataConfig.safeParse({ model: '' }).success).toBe(false);
  });
});
