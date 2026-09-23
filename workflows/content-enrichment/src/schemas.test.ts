import { SummaryInput } from '@ai-pipeline/contract-summary';
import { describe, expect, it } from 'vitest';
import { ContentEnrichmentRequest, ContentInput, ContentPublishedEvent } from './schemas.js';

/** This workflow's own contract, and the one cross-unit limit it has to respect. */
describe('ContentInput', () => {
  it('requires an id and text, and treats the title as optional', () => {
    expect(ContentInput.safeParse({ contentId: 'c-1', text: 'hello' }).success).toBe(true);
    expect(ContentInput.safeParse({ contentId: 'c-1' }).success).toBe(false);
    expect(ContentInput.safeParse({ text: 'hello' }).success).toBe(false);
  });

  it('refuses unknown keys', () => {
    expect(ContentInput.safeParse({ contentId: 'c', text: 't', extra: 1 }).success).toBe(false);
  });
});

describe('ContentEnrichmentRequest', () => {
  it('carries the trigger context alongside the input', () => {
    const parsed = ContentEnrichmentRequest.safeParse({
      input: { contentId: 'c', text: 't' },
      trigger: { type: 'rest', id: 'api', receivedAt: 1_700_000_000_000 },
    });
    expect(parsed.success).toBe(true);
  });

  it('will not accept a request with no trigger context', () => {
    // The control plane builds the trigger context; a request without one did not come through it.
    expect(
      ContentEnrichmentRequest.safeParse({ input: { contentId: 'c', text: 't' } }).success,
    ).toBe(false);
  });
});

describe('ContentPublishedEvent', () => {
  it('accepts the producer shape and tolerates extra fields', () => {
    const event = { identifier: 'do_1', objectType: 'Content', edata: { body: 'b', other: 1 } };
    expect(ContentPublishedEvent.safeParse(event).success).toBe(true);
  });

  it('requires an identifier and a body', () => {
    expect(ContentPublishedEvent.safeParse({ edata: { body: 'b' } }).success).toBe(false);
    expect(ContentPublishedEvent.safeParse({ identifier: 'x', edata: {} }).success).toBe(false);
  });
});

describe('the limit this workflow has to respect in its callee', () => {
  it('the largest valid ContentInput still fits SummaryInput (title + blank line + text)', () => {
    // The workflow concatenates title and text before calling summary, so its own maxima have to
    // add up to something the summary contract accepts. This is the caller's responsibility.
    const input = ContentInput.parse({
      contentId: 'c',
      title: 't'.repeat(1000),
      text: 'x'.repeat(100_000),
    });
    const text = `${input.title}\n\n${input.text}`;
    expect(SummaryInput.safeParse({ text, maxWords: 1000 }).success).toBe(true);
  });
});
