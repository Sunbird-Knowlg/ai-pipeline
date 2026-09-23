import { describe, expect, it } from 'vitest';
import { SUMMARY_TEXT_MAX, SummaryConfig, SummaryInput, SummaryOutput } from './schemas.js';

/** The summary contract. Shared, because `content-enrichment` calls this service. */
describe('SummaryInput', () => {
  it('requires text and a word budget in range', () => {
    expect(SummaryInput.safeParse({ text: 'hi', maxWords: 120 }).success).toBe(true);
    expect(SummaryInput.safeParse({ text: '', maxWords: 120 }).success).toBe(false);
    expect(SummaryInput.safeParse({ text: 'hi', maxWords: 9 }).success).toBe(false);
    expect(SummaryInput.safeParse({ text: 'hi', maxWords: 1001 }).success).toBe(false);
  });

  it('refuses unknown keys, so a caller cannot smuggle fields past the contract', () => {
    expect(SummaryInput.safeParse({ text: 'hi', maxWords: 120, extra: 1 }).success).toBe(false);
  });

  it('accepts text up to the documented maximum and no further', () => {
    expect(
      SummaryInput.safeParse({ text: 'x'.repeat(SUMMARY_TEXT_MAX), maxWords: 10 }).success,
    ).toBe(true);
    expect(
      SummaryInput.safeParse({ text: 'x'.repeat(SUMMARY_TEXT_MAX + 1), maxWords: 10 }).success,
    ).toBe(false);
  });
});

describe('SummaryConfig', () => {
  it('defaults the output budget rather than requiring every unit to state it', () => {
    expect(SummaryConfig.parse({ model: 'chat-default' })).toEqual({
      model: 'chat-default',
      maxOutputTokens: 512,
    });
  });

  it('requires a model', () => {
    expect(SummaryConfig.safeParse({}).success).toBe(false);
    expect(SummaryConfig.safeParse({ model: '' }).success).toBe(false);
  });
});

describe('SummaryOutput', () => {
  it('reports which model produced the summary', () => {
    expect(SummaryOutput.safeParse({ summary: 's', model: 'chat-default' }).success).toBe(true);
    expect(SummaryOutput.safeParse({ summary: 's' }).success).toBe(false);
  });
});
