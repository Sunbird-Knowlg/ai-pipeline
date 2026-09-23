import { describe, expect, it } from 'vitest';
import { adapters } from './adapters.js';
import { textStats } from './steps.js';

describe('contentPublished adapter', () => {
  it('maps a content.published event to ContentInput', () => {
    const event = {
      identifier: 'do_1',
      objectType: 'Content',
      edata: { title: 'T', body: 'Hello world' },
    };
    expect(adapters.contentPublished(event)).toEqual({
      contentId: 'do_1',
      title: 'T',
      text: 'Hello world',
    });
  });

  it('skips other object types (whatever their shape) and rejects malformed content', () => {
    expect(
      adapters.contentPublished({ identifier: 'x', objectType: 'Asset', edata: { body: 'b' } }),
    ).toBeNull();
    expect(adapters.contentPublished({ identifier: 'q1', objectType: 'Question' })).toBeNull();
    expect(() => adapters.contentPublished({ identifier: 'x' })).toThrow();
  });

  it('treats a null title as absent', () => {
    const event = { identifier: 'd', objectType: 'Content', edata: { title: null, body: 'b' } };
    expect(adapters.contentPublished(event)).toEqual({ contentId: 'd', text: 'b' });
  });
});

describe('textStats', () => {
  it('counts words and characters', () => {
    expect(textStats('  one two\nthree  ')).toEqual({
      wordCount: 3,
      charCount: 17,
      readingTimeMinutes: 0,
    });
  });
});
