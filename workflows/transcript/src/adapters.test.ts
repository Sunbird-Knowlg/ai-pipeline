import { describe, expect, it } from 'vitest';
import { silentLogger } from '@ai-pipeline/observability/testing/logger';
import { adapters } from './adapters.js';

const log = silentLogger();

function event(overrides: Record<string, unknown> = {}) {
  return {
    eid: 'BE_JOB_REQUEST',
    edata: {
      action: 'content-published',
      identifier: 'do_1',
      objectType: 'Content',
      mimeType: 'video/mp4',
      enrichmentTypes: ['Transcript'],
      ...overrides,
    },
  };
}

describe('contentPublishedEvent', () => {
  it('skips a publish that did not request Transcript', () => {
    expect(adapters.contentPublishedEvent(event({ enrichmentTypes: [] }), log)).toBeNull();
  });

  it('skips a non-Content publish without requiring the Content shape', () => {
    // A Collection/Question publish has no mimeType at all -- must be skipped, not fail as malformed.
    const collectionEvent = {
      eid: 'BE_JOB_REQUEST',
      edata: {
        action: 'content-published',
        identifier: 'do_1',
        objectType: 'Collection',
        enrichmentTypes: ['Transcript'],
      },
    };
    expect(adapters.contentPublishedEvent(collectionEvent, log)).toBeNull();
  });

  it('skips an unsupported mimeType', () => {
    expect(adapters.contentPublishedEvent(event({ mimeType: 'application/pdf' }), log)).toBeNull();
  });

  it('defaults channel to "all" when missing', () => {
    const result = adapters.contentPublishedEvent(event(), log);
    expect(result).toMatchObject({ identifier: 'do_1', channel: 'all' });
  });

  it('keeps an explicit channel', () => {
    const result = adapters.contentPublishedEvent(event({ channel: '0123' }), log);
    expect(result).toMatchObject({ channel: '0123' });
  });

  it('throws on a malformed envelope once the event is known relevant', () => {
    // Passes the eligibility gate (objectType/mimeType/enrichmentTypes all present and matching)
    // but is missing `identifier`, which the strict schema requires.
    const malformed = {
      eid: 'BE_JOB_REQUEST',
      edata: {
        action: 'content-published',
        objectType: 'Content',
        mimeType: 'video/mp4',
        enrichmentTypes: ['Transcript'],
      },
    };
    expect(() => adapters.contentPublishedEvent(malformed, log)).toThrow();
  });
});
